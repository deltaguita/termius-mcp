# Changelog

## 0.2.0 - 2026-10-12

### Added
- `connect_host(host, dry_run, wait)`: opens a saved Termius host in a new tab of the current
  window and claims the tab for the calling session. Only saved host labels are accepted; no
  free-form address, no new window. Refused while several main windows exist. One connect at a
  time across all MCP processes. `TERMIUS_CONNECT_ALLOW` limits which labels may be opened.
- First-time host-key prompts are answered automatically (`TERMIUS_HOSTKEY`, default `add` =
  "Add and continue"; `once` = "Continue"; `ask` = press nothing). The prompt is matched by the
  host's address, the fingerprint is returned in the tool output, and a changed-key warning or
  two prompts naming the same address are never answered. Password prompts are never answered.
- `tests/test_connect.py` and `answerHostKey` / `connectHost` tests in `tests/bridge.test.js`.

### Changed
- `connect_host` passes Termius' own live Host object to its connect function (the Redux copy
  lacks the getters it needs and made a real connect fail with a `TypeError`).

## 0.1.0 - 2026-10-08

### Added
- Tools: `list_hosts`, `list_keychain`, `list_terminal_sessions`, `read_terminal`,
  `claim_terminal`, `release_terminal`, `run_command`, `send_key`, `send_text`.
- Input safety: per-tab claims (a tab accepts input only from the session that claimed it),
  cross-process per-tab lock, prompt check before typing, multi-window guard.
- Terminals are found through Termius' mediator pool first, so tabs that are not on screen are
  reachable; the DOM scan is the fallback.
- Secrets are never returned: hosts, keychain and sessions output are whitelisted fields only.

### Fixed
- The prompt check no longer treats a progress line ending in `%`, `$`, `#` or `>` as a shell
  prompt (cursor must follow "symbol + space" and the screen must be still).
- `run_command` completion uses the same cursor-position check.
