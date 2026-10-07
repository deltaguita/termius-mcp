# Security notes

## The debug port is the biggest risk

Termius must be started with `--remote-debugging-port`. While it is open, **any process on this
machine can connect to the Termius renderer and run JavaScript in it**, including reading the
decrypted vault (hosts, identities, passwords, private keys) that Termius keeps in renderer memory.
This is a larger exposure than anything the agent itself can do.

- Open it only when needed; quit and restart Termius normally afterwards.
- Never add it to a login item, launch agent or shell alias.
- The server binds nothing itself and only connects to `127.0.0.1:<port>`; it refuses any page
  that is not `file:///Applications/Termius.app/` with `type=primary`.

## What this protects against

| Threat | Protection |
|---|---|
| Agent reads credentials | Bridge returns whitelisted fields only; tested with planted secrets |
| Agent opens connections of its own | No such tool; it can only use tabs you opened and logged in |
| Two agents typing into one tab at the same instant | Per-tab cross-process lock; second caller refused |
| Another agent inserting a command between yours (`cd` then `rm`) | Exclusive claims; input refused unless the calling session owns the tab |
| Typing into a program that is still running | `run_command` only sends when the cursor line is an empty prompt |
| Typing into the wrong host | Input tools require an explicit, unambiguous tab; no fallback to the active tab |
| Typing when part of the tab list is invisible (several windows) | Input and claims refused; reads warn that the view is partial |
| Multi-line paste executing several commands | `send_text` and `run_command` reject newlines |
| Stale claim blocking a tab forever | Claim dies with its process, or after 15 idle minutes |
| A crashed agent leaving a lock | Locks are `flock`s, released by the kernel when the process dies |
| Unattended execution | Execute and input tools are not read-only; clients should require approval for them |

## Limits that remain

- **Debug port.** See above. Not mitigated by this server.
- **Same-user processes.** Claim and lock files are plain files owned by your user (directory mode
  0700). Malware running as you can forge them, or skip this server and use the debug port directly.
  They coordinate cooperating agents; they are not a security boundary.
- **A human typing in Termius.** Claims and locks only serialise MCP callers. If you type into a
  claimed tab, your keystrokes mix with the agent's. The prompt check catches half-typed text,
  but not a command you submit at the same moment.
- **Prompt detection is a heuristic.** `run_command` types only when (1) the cursor sits right
  after a prompt symbol plus a space (`$ # % > ❯`, or the oh-my-zsh default) with nothing to its
  right, and (2) the screen has not changed for 0.3 s. Output such as `Downloading... 45%`
  fails the first test (no space after the symbol); a live progress bar fails the second. It is
  still a guess about the foreground process: a program that parks the cursor after `> ` or `$ `
  and stays silent (a Python or SQL REPL, `read -p "x> "`) is mistaken for a shell prompt, so
  the next `run_command` would type into it. Prompts that do not end in those symbols (or that
  end without a trailing space) are refused, which is safe but unusable. Read the screen after
  a `timeout` status, and interrupt with `send_key('ctrl-c')` before reusing the tab.
- **Claim owner = server process.** If a client runs several agent sessions through one server
  process, they share claims. If a process id is reused by the OS after a crash, a stale claim can
  look alive until the 15-minute idle limit.
- **Claims are per tab id, not per window.** Several windows are refused rather than supported.
- **Termius internals.** `bridge.js` depends on Termius' React and xterm structure; an update can
  break it. Breakage shows up as errors (`terminal not found`, `Termius state store not found`),
  not as typing into the wrong place, because input is addressed by session id and verified
  against the terminal's own id.
- **Audit trail.** Termius' own session logs are encrypted and kept by the client, so they are not
  an audit trail you can rely on. The record of what ran is the agent conversation. For
  compliance-grade auditing use server-side controls (bastion, SSM Session Manager, IAP) that do
  not depend on which client is used.
- **Background tabs are verified by simulation only.** On Termius 10.1.3 a tab moved to the
  background (or the Hosts screen) keeps its terminal element mounted, so a truly unmounted tab
  was never observed. The pool lookup is tested against a fake and by hiding the DOM from the
  bridge, not against a real unmounted tab.
- **No terms-of-service review.** Whether Termius permits driving its app this way has not been checked.
