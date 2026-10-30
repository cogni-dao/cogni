#!/usr/bin/python3 -I
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Fixed forced-command supervisor: 20s wall bound plus 2s group kill grace.

This root-owned program is the only future SSH command. It cannot select a
program, owner, path or namespace. H1 does not install keys or activate it.
"""
import os
import signal
import subprocess
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from kernel import die_with_parent


def main():
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND') or os.geteuid() != 0:
        return 1
    child = subprocess.Popen(['/usr/bin/python3', '-I', str(Path(__file__).resolve().with_name('entrypoint.py'))],
                             start_new_session=True, preexec_fn=lambda parent=os.getpid(): die_with_parent(parent),
                             env={key: value for key, value in os.environ.items()
                                  if key in ('SSH_ORIGINAL_COMMAND', 'SSH_CONNECTION')})
    def stop(_sig=None, _frame=None):
        if child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait()
        raise SystemExit(1)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, stop)
    try:
        return child.wait(timeout=20)
    except subprocess.TimeoutExpired:
        stop()
    finally:
        # Reap any descendant in the worker group even after a normal worker exit.
        try:
            os.killpg(child.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass


if __name__ == '__main__':
    sys.exit(main())
