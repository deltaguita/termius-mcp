#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp==1.27.0", "websockets==17.2"]
# ///
"""Manual smoke test against a REAL Termius (not collected by pytest).

    uv run --script tests/smoke_live.py ["Local Terminal"]

Needs Termius running with --remote-debugging-port=9222 and a LOCAL tab open.
It refuses to type into anything that is not a local tab, so it cannot touch a
remote host. It types a few harmless `echo` commands into that tab.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import server  # noqa: E402

NAME = sys.argv[1] if len(sys.argv) > 1 else "Local Terminal"
results = []


def check(label, ok, detail=""):
    results.append(ok)
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f"  -- {detail}" if detail and not ok else ""))


async def refused(coro):
    try:
        await coro
    except (RuntimeError, ValueError) as e:
        return str(e)
    return None


async def main():
    async with server.Page() as p:
        sessions = await p.call("sessions")
        windows = p.windows
    target = next((s for s in sessions if s["name"].lower() == NAME.lower()), None)
    if not target:
        sys.exit(f"no tab named {NAME!r}; open: {[s['name'] for s in sessions]}")
    if target["protocol"] != "local":
        sys.exit(f"{NAME!r} is a {target['protocol']} tab; this smoke test only types into local tabs")
    if windows > 1:
        sys.exit(f"{windows} Termius main windows are open; close the extras first")

    await server.release_terminal(NAME)          # start from a known state
    r = await refused(server.run_command("echo SMOKE-NOCLAIM", NAME))
    check("run_command is refused without a claim", r is not None and "claim_terminal" in r, r)
    screen = await server.read_terminal(NAME, lines=15)
    check("refused command was not typed", "SMOKE-NOCLAIM" not in screen)

    await server.claim_terminal(NAME)
    out = await server.run_command("echo 中文🚀 $((6*7)) rc=$?", NAME)
    check("run_command returns exact output (CJK, emoji, arithmetic)", out.endswith("中文🚀 42 rc=0"), out)

    wide = "中" * 130
    out = await server.run_command(f"echo {wide}", NAME)
    check("130 wide chars over several rows come back as exactly 130", out.splitlines()[-1] == wide,
          f"{len(out.splitlines()[-1])} chars")

    r = await refused(server.send_text("a\nb", NAME))
    check("send_text rejects newlines", r is not None, r)

    listing = await server.list_terminal_sessions()
    check("listing shows the claim", "claimed by THIS session" in listing, listing)

    await server.send_text("echo SMOKE-PENDING", NAME)       # leaves text on the line
    r = await refused(server.run_command("echo SMOKE-SECOND", NAME))
    check("run_command refuses when text is already on the prompt line", r is not None and "prompt" in r, r)
    await server.send_key("ctrl-u", NAME)

    # A running program whose last line ends in "%" must not pass as a prompt.
    out = await server.run_command("printf 'Downloading... 45%%'; sleep 8", NAME, timeout=2)
    check("long command reports it has not finished", "status: timeout" in out, out)
    r = await refused(server.run_command("echo SMOKE-INTO-RUNNING", NAME))
    check("run_command refuses while a progress line is on the cursor row", r is not None, r)
    screen = await server.read_terminal(NAME, lines=15)
    check("nothing was typed into the running command", "SMOKE-INTO-RUNNING" not in screen)
    await asyncio.sleep(9)                                   # let `sleep 8` finish
    out = await server.run_command("echo SMOKE-AFTER", NAME)
    check("run_command works again once the program exits", out.endswith("SMOKE-AFTER"), out)

    await server.release_terminal(NAME)
    r = await refused(server.send_key("enter", NAME))
    check("input refused again after release", r is not None and "not claimed" in r, r)

    print(f"\n{sum(results)}/{len(results)} passed")
    sys.exit(0 if all(results) else 1)


asyncio.run(main())
