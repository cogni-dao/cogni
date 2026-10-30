#!/usr/bin/python3 -I
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Fixed forced-command supervisor: 20s wall bound plus 2s group kill grace.

This root-owned program is the only future SSH command. It cannot select a
program, owner, path or namespace. H1 does not install keys or activate it.
"""
import hashlib
import json
import re
import stat
import types
import os
import signal
import subprocess
import sys
from pathlib import Path
sys.dont_write_bytecode = True


def verified_source():
    """Stdlib-only bootstrap; no sibling search path or code before trust checks."""
    base = Path(__file__).absolute().parent
    def read_regular(path, cap=65536):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('untrusted_source_file')
            data = os.read(fd, cap+1)
            if len(data) > cap:
                raise RuntimeError('source_overflow')
            return data
        finally:
            os.close(fd)
    for parent in (base, *base.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise RuntimeError('untrusted_source_ancestor')
    raw = read_regular(base/'source.json', 32768)
    manifest = json.loads(raw)
    if not re.fullmatch('[0-9a-f]{40}', manifest['sourceSha']):
        raise RuntimeError('source_identity')
    closure = {}
    for name in ('entrypoint.py', 'wrapper.py', 'admission.py', 'kernel.py'):
        data = read_regular(base/name)
        if hashlib.sha256(data).hexdigest() != manifest['files'][name]:
            raise RuntimeError('source_digest')
        closure[name] = data
    # Only these two explicitly verified modules become local imports. Their
    # stdlib imports resolve through the system path; base is NEVER on sys.path.
    loaded = {}
    for name in ('admission', 'kernel'):
        module = types.ModuleType(name)
        module.__file__ = str(base/(name+'.py'))
        sys.modules[name] = module
        exec(compile(closure[name+'.py'], module.__file__, 'exec'), module.__dict__)
        loaded[name] = module
    return base, manifest, hashlib.sha256(raw).hexdigest(), loaded


def main():
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND') or os.geteuid() != 0:
        return 1
    _, _, _, modules = verified_source()
    die_with_parent = modules['kernel'].die_with_parent
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
    try:
        sys.exit(main())
    except Exception:
        sys.exit(1)
