#!/usr/bin/env python3
"""External wall-clock limit for Bun tests; timers inside Bun may be starved.

Usage: python3 run-bun-tests.py [Bun test arguments...]
CODEX_TELEGRAM_BUN_TEST_TIMEOUT_SECONDS defaults to 60 (allowed: 0.05..600).
Children must remain in the new process group; deliberately detached children
and SIGKILL of this supervisor cannot be cleaned up by a userspace supervisor.
"""

import math
import os
import signal
import subprocess
import sys
import time


def signal_group(pgid, sig):
    try:
        os.killpg(pgid, sig)
    except ProcessLookupError:
        return False
    except PermissionError:
        # macOS can report EPERM for a group containing only an exited,
        # unreaped process. Confirm no executing member rather than masking
        # a genuine permission failure. A failed inspection fails closed.
        snapshot = subprocess.run(
            ["/bin/ps", "-axo", "pgid=,stat="], check=True,
            capture_output=True, text=True, timeout=2)
        for line in snapshot.stdout.splitlines():
            group, state = line.split()
            if int(group) == pgid and not state.startswith("Z"):
                raise
        return False
    return True


def run(command, timeout):
    """Stream output, preserve exit status, and always retire our process group."""
    interrupted = None

    def on_signal(signum, _frame):
        nonlocal interrupted
        interrupted = signum

    previous = {sig: signal.signal(sig, on_signal)
                for sig in (signal.SIGINT, signal.SIGTERM)}
    child = None
    result = 1
    try:
        child = subprocess.Popen(command, start_new_session=True)
        deadline = time.monotonic() + timeout
        while True:
            if interrupted is not None:
                result = 128 + interrupted
                print("Bun test supervisor: interrupted; stopping process group", file=sys.stderr)
                break
            status = child.poll()
            if status is not None:
                result = status if status >= 0 else 128 - status
                break
            if time.monotonic() >= deadline:
                result = 124
                print(f"Bun test supervisor: wall-clock timeout after {timeout:g}s; stopping process group", file=sys.stderr)
                break
            time.sleep(min(0.02, max(0, deadline - time.monotonic())))
    finally:
        try:
            if child is not None:
                # Reap the direct child before signaling again: on macOS an
                # unreaped exited Bun can cause killpg to report EPERM.
                # Descendants still share the exclusively created PGID.
                for sig in (signal.SIGTERM, signal.SIGKILL):
                    child.poll()
                    if not signal_group(child.pid, sig):
                        break
                    if sig == signal.SIGTERM:
                        time.sleep(0.2)
                child.wait()
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    return result


def main():
    try:
        timeout = float(os.environ.get("CODEX_TELEGRAM_BUN_TEST_TIMEOUT_SECONDS", "60"))
        if not math.isfinite(timeout) or not 0.05 <= timeout <= 600:
            raise ValueError
    except ValueError:
        print("CODEX_TELEGRAM_BUN_TEST_TIMEOUT_SECONDS must be finite and between 0.05 and 600", file=sys.stderr)
        return 2
    try:
        return run(["bun", "test", *sys.argv[1:]], timeout)
    except OSError as error:
        print(f"Bun test supervisor: {error}", file=sys.stderr)
        return 127


if __name__ == "__main__":
    sys.exit(main())
