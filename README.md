# termius-mcp

An MCP server that lets an AI agent work in the terminal tabs you **already have open** in
[Termius](https://termius.com), with guard rails for letting several agents share one Termius.

- The agent never sees passwords or private keys and never opens connections: you log in
  through Termius as usual, the agent types into the tab.
- Text is read from the xterm.js buffer (no screenshots, no OCR).
- Every command the agent runs is visible in your terminal and in the agent conversation.

> **Read [SECURITY.md](SECURITY.md) before using this.** It requires Termius to run with a
> debug port open, which exposes your decrypted vault to every process on the machine while it is open.

Verified against Termius 10.1.3 (Electron 43.5.1) on macOS. It relies on Termius internals that
are not a public API, so a Termius update can break it.

## What kind of MCP is this?

It is an **app-internals MCP over the Chrome DevTools Protocol (CDP)**: it drives a desktop
Electron app the way browser-automation MCPs drive a web page, but one level lower than the DOM.

| | Browser / DOM MCPs (Playwright, Puppeteer) | GUI / computer-use MCPs | termius-mcp |
|---|---|---|---|
| Transport | CDP or WebDriver | Screenshots, mouse and keyboard events | CDP (`Runtime.evaluate` on Termius' renderer) |
| Reads | DOM elements, accessibility tree | Pixels (OCR / vision) | Termius' React/Redux state and the xterm.js text buffer |
| Acts by | Clicking and typing into DOM elements | Moving the mouse, pressing keys on screen | Calling `terminal.input()` on the terminal object |
| Needs the tab on screen | Yes | Yes | No |
| Output is | Page text and element refs | A picture to interpret | Exact text, no OCR errors |

Why not the DOM: Termius draws the terminal on an xterm.js canvas, so the text is not in the DOM
at all, and a screenshot would have to be read back by OCR, where one wrong character in a path or
IP changes the meaning. So the server injects a small script (`bridge.js`) into the renderer,
locates the live objects through React internals, and reads and writes them directly.

What that means in practice:

- **Needs a debug port.** Termius must be started with `--remote-debugging-port`; see [SECURITY.md](SECURITY.md).
- **Tied to Termius internals.** No public API is used, so an app update can break it.
- **Not a general browser tool.** It refuses any page that is not Termius' own main window.
- **Not a remote-shell tool.** It never opens connections; it uses tabs you have already logged in.

## Features

| Area | What you get |
|---|---|
| Read | `list_hosts`, `list_keychain` (names only, whitelisted fields), `list_terminal_sessions`, `read_terminal` (screen or full scrollback) |
| Execute | `run_command` types one command, waits for the prompt to return, returns only that command's output (echo and prompt stripped) |
| Low-level input | `send_text` (no Enter), `send_key` (enter, ctrl-c, ctrl-u, arrows, ...) |
| Multi-agent safety | `claim_terminal` / `release_terminal`; one input call per tab at a time; input refused when the tab list is incomplete (multiple windows) |
| Output filtering | ANSI stripped, trailing whitespace trimmed, blank runs collapsed, output over 200 lines keeps head and tail with an omitted-lines marker |
| Wide characters | Soft-wrapped rows are re-joined into logical lines; CJK and emoji are handled (verified with 130 wide characters across several rows) |
| Background tabs | Tabs are located through Termius' terminal pool, so tabs that are not on screen can be read and typed into (verified by simulation; see SECURITY.md) |
| Tool annotations | Read tools are marked read-only, `run_command` destructive, so a client can auto-approve only the safe ones |

Not included: opening connections or tabs, closing tabs, resizing, file transfer.

## Tools

| Tool | Kind | Description |
|---|---|---|
| `list_hosts(query?)` | read | Saved hosts: label, `user@address:port`, group, auth type (`key`/`password`/`none`), jump-host count |
| `list_keychain()` | read | Identities (only whether a password exists), SSH key names, hardware key names, known-host key types |
| `list_terminal_sessions()` | read | Open tabs: id prefix, name, protocol, address, connection state, `active`, `background`, claim owner |
| `read_terminal(session?, lines=40, scrollback=false)` | read | Last `lines` lines of the screen, or the whole history (capped at 200 lines) |
| `claim_terminal(session)` | claim | Take exclusive input rights on a tab |
| `release_terminal(session)` | claim | Give them up (only the owner can) |
| `send_text(text, session)` | input | Type text without pressing Enter; rejects newlines |
| `send_key(key, session)` | input | One control key from a fixed list |
| `run_command(command, session, timeout=30)` | **execute** | One command (no newlines), `timeout` 1-600 s |

`session` accepts an id prefix, a tab name (host label; `Local Terminal` for local tabs) or an
address, case-insensitively. Several matches are rejected with the candidates listed. With exactly
one open tab it may be omitted; with several, read tools fall back to the active tab but **input
tools and claims always require it**.

`run_command` returns a status line when the command has not finished by `timeout`
(`timeout`) or looks like it is waiting for input (`waiting-for-input`, e.g. a password prompt);
follow up with `read_terminal` and `send_key`.

## Input safety model

Input tools (`run_command`, `send_key`, `send_text`) pass these checks; any failure refuses the
call and **nothing is typed**.

1. **One window.** If more than one Termius main window is open, input and claims are refused
   (see [Multiple windows](#multiple-windows)).
2. **Explicit target.** With several tabs open the tab must be named; the active tab is never guessed.
3. **Per-tab call lock.** Only one input call per tab runs at a time, across processes. A second
   caller waits up to 5 s, then is refused rather than queued behind a long command.
4. **Claim.** The tab must be claimed by this session.
5. **Prompt check** (`run_command` only). The cursor must sit right after a prompt symbol and a
   space (`$ `, `% `, `# `, `> `, `❯ ` or the oh-my-zsh default) with nothing to its right, and
   the screen must stay unchanged for 0.3 s. If a command is still running, text is already
   typed, or a program is drawing (`Downloading... 45%`), the call is refused: keystrokes would
   otherwise land in the running program's stdin and be executed later at an unpredictable moment.
   The same cursor check decides when a command has finished.
6. **Echo check** (`run_command` only). The command is typed first and sent with Enter only
   after the echo has stopped changing; if it never settles, the line is cleared (ctrl-u) and nothing runs.

### Claims

A claim gives one agent session exclusive input rights on a tab. It exists because the per-call
lock cannot stop agent B from slipping a command between two calls of agent A
(`cd /srv/app`, then B's `cd /tmp`, then A's `rm -rf cache/`).

- The owner is the MCP server process. This assumes the client starts **one server process per
  agent session**; if a client shares one process between sessions, they share its claims.
- A claim ends when the owner calls `release_terminal`, when the owner process exits, or after 15
  minutes without an input call (`TERMIUS_CLAIM_IDLE`, longer than the 600 s `run_command` limit).
- Reads are never restricted. `list_terminal_sessions` shows who holds each tab.
- Only the owner can release. There is deliberately no tool to take over someone else's claim;
  a human can delete `<TERMIUS_LOCK_DIR>/<tab-id>.claim`.

### Multiple windows

The server talks to exactly one Termius renderer. With several main windows, the tabs of the
others are invisible, and a name like `web-1` could exist in two windows. So:

| Situation | Behaviour |
|---|---|
| Exactly one main window | Normal operation |
| More than one main window | `claim_terminal`, `run_command`, `send_key`, `send_text` are refused with `Nothing was sent.`, even for a tab that was claimed earlier |
| More than one main window, read tools | `read_terminal` and `list_terminal_sessions` still work and append a `WARNING:` that the view is partial |
| Window choice | The window with the lexicographically smallest target URL, so repeated calls hit the same one |
| Settings window, Termius background process, other Electron apps on the port | Ignored and not counted; only targets under `file:///Applications/Termius.app/` with `type=primary` are used |
| Tab ids | Session ids are unique across windows, so claims and locks (keyed by tab id) cannot collide |
| Different agent sessions | Claims and locks live in a fixed directory shared by all server processes, independent of each session's `TMPDIR` |

Whether Termius can show several *primary* windows at once was not observed on 10.1.3 (only
one `type=primary` target appeared); the guard exists so that if it does, input fails closed.

## Output filtering and what is never returned

`bridge.js` is injected into the Termius renderer, where the Redux store holds decrypted
passwords and private keys. Every bridge function returns **whitelisted fields only**; host and
keychain entries are never passed through as objects. Tests assert that planted secrets in the
host, identity, SSH key, hardware key and known-host records do not appear in any output.

## Setup

1. Start Termius with a debug port (see [SECURITY.md](SECURITY.md) first):

   ```bash
   osascript -e 'quit app "Termius"'; sleep 2
   open -na Termius --args --remote-debugging-port=9222
   ```

   Close it by quitting and starting Termius normally.

2. Register the server in your MCP client (requires [uv](https://docs.astral.sh/uv/); dependencies
   are pinned in the script header and installed on first run):

   ```json
   {
     "mcpServers": {
       "termius": {
         "command": "uv",
         "args": ["run", "--quiet", "--script", "/path/to/server.py"],
         "autoApprove": ["list_hosts", "list_keychain", "list_terminal_sessions", "read_terminal"]
       }
     }
   }
   ```

   Auto-approve only the read tools. Leave `claim_terminal`, `release_terminal`, `send_text`,
   `send_key` and `run_command` on manual approval so a human sees each command before it runs.

3. Open the tabs you want the agent to use in Termius. Prefer a tab of its own over one you are typing in.

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TERMIUS_CDP_PORT` | `9222` | Debug port |
| `TERMIUS_LOCK_DIR` | `/tmp/termius-mcp-locks-<uid>` | Claim and lock files; keep it identical for all agent sessions |
| `TERMIUS_LOCK_WAIT` | `5` | Seconds to wait for the per-tab call lock |
| `TERMIUS_SETTLE` | `0.3` | Seconds the screen must stay unchanged before `run_command` types |
| `TERMIUS_CLAIM_IDLE` | `900` | Seconds without an input call before a claim expires |

## Tests

```bash
# Python: tools, claims, locks, multi-window guard (fake Termius, no GUI needed)
uv run --with pytest --with mcp==1.27.0 --with websockets==17.2 python -m pytest tests -q

# JavaScript: bridge.js against a fake React/xterm tree
node --test tests/

# Manual, against a real Termius; types echo commands into a LOCAL tab only
uv run --script tests/smoke_live.py "Local Terminal"
```

| Suite | Covers |
|---|---|
| `tests/test_filters.py` | ANSI stripping, blank-run collapsing, head/tail capping, prompt and cursor-position detection, key table |
| `tests/test_claims_and_locks.py` | Claim ownership, dead owner, idle expiry, corrupt claim file, cross-process lock, lock released on crash, lock directory permissions |
| `tests/test_tools.py` | Every input tool refused without a claim and nothing typed; target resolution; `run_command` against a running, half-typed, progress-line or still-drawing tab, and a stalled progress line not mistaken for completion; claim not stolen when a command outlives its claim |
| `tests/test_multi_window.py` | Window counting and selection, input/claims refused with several windows, partial-view warning on reads |
| `tests/bridge.test.js` | No secrets in `hosts`/`keychain`/`sessions`; pool lookup for unmounted tabs; no cross-tab delivery; wide-character row joining; cursor-position text for prompt detection |
| `tests/smoke_live.py` | End-to-end on a real local tab (12 checks, including a running progress line) |

Known limits that tests cannot remove (a REPL parked at `> ` looks like a prompt) are listed in
[SECURITY.md](SECURITY.md#limits-that-remain).

## How it works

`server.py` connects to Termius' renderer over the Chrome DevTools Protocol and injects
`bridge.js` (re-injected when its content hash changes). The bridge reads hosts and tabs from
the app's Redux store and finds each terminal through Termius' mediator pool
(`singletons.mediatorPool.mediatorMap`, keyed by session id, present whether or not the tab is on
screen), falling back to scanning mounted `.xterm` elements. It reads with `buffer.active.getLine()`
and types with `terminal.input()`; neither needs the tab to be visible.
