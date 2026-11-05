#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Fixed host guard for runtime publication, recovery and gateway activation (bug.5570)."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import threading
import time

ROOT = Path('/var/lib/cogni/runtime-maintenance')
TERMINAL = {'activated', 'rolled_back'}
VERSION = 1
OWNER_UID = 0
HELPER_FILES = ('runtime-maintenance-guard.py', 'runtime-recovery-receipt.py', 'gateway-activation-host.py',
                'runtime-recovery-host.py', 'runtime-guard-install.py')

class GuardError(RuntimeError):
    pass

def private_directory(path):
    if path.exists() or path.is_symlink():
        if path.is_symlink() or not path.is_dir() or path.stat().st_uid != OWNER_UID:
            raise GuardError('runtime_guard_directory_untrusted')
    else:
        path.mkdir(mode=0o700, parents=True)
        sync_directory(path.parent)
    os.chmod(path, 0o700)

def sync_directory(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def private_read(path, limit=1048576):
    """Read only a root-owned ordinary private file, without following links."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID or info.st_mode & 0o077 or info.st_size > limit:
            raise GuardError('runtime_guard_file_untrusted')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise GuardError('runtime_guard_file_oversized')
        return data
    finally:
        os.close(fd)

def validate_installation():
    """Under the held guard, admit only a completely published helper bundle."""
    try:
        installed = json.loads(private_read(ROOT / 'guard.json'))
        if not isinstance(installed, dict) or set(installed) != {'protocolVersion', 'sourceSha', 'blobs', 'qualifiedAt', 'recoveryCaller'}:
            raise ValueError()
        if installed.get('protocolVersion') != VERSION or not re.fullmatch(r'[a-f0-9]{40}', installed.get('sourceSha', '')):
            raise ValueError()
        if set(installed.get('blobs', {})) != set(HELPER_FILES):
            raise ValueError()
        for name in HELPER_FILES:
            expected = installed['blobs'][name]
            if not re.fullmatch(r'[a-f0-9]{64}', expected) or hashlib.sha256(private_read(ROOT / 'lib' / name)).hexdigest() != expected:
                raise ValueError()
        return installed
    except (OSError, ValueError, TypeError, GuardError):
        raise GuardError('runtime_guard_installation_incomplete') from None

def run_native(lock_fd, argv, *, env, cwd, timeout, input_bytes=None):
    """Retain the host lock for a native child's complete execution lifetime.

    Regular private output avoids SIGPIPE when the host parent dies. A caller
    timeout leaves the child and its inherited lock alive; resume sees busy
    until that execution exits, then observes its effects before acting.
    """
    if lock_fd is None:
        raise GuardError('runtime_native_guard_required')
    own, held = (ROOT / 'lock').stat(), os.fstat(lock_fd)
    if (own.st_dev, own.st_ino) != (held.st_dev, held.st_ino):
        raise GuardError('runtime_native_guard_invalid')
    with tempfile.TemporaryFile(dir=ROOT) as output:
        process = subprocess.Popen(argv, stdin=subprocess.PIPE if input_bytes is not None else subprocess.DEVNULL,
                                   stdout=output, stderr=subprocess.DEVNULL, env=env, cwd=cwd, pass_fds=(lock_fd,))
        try:
            process.communicate(input_bytes, timeout=timeout)
        except subprocess.TimeoutExpired:
            # Do not kill just the client while a native operation may survive.
            # Reap it if this caller stays alive; caller death leaves its child
            # holding the descriptor until the native execution itself exits.
            threading.Thread(target=process.wait, daemon=True).start()
            raise GuardError('runtime_native_outcome_pending') from None
        if process.returncode:
            raise GuardError('runtime_native_command_failed')
        output.seek(0)
        data = output.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            raise GuardError('runtime_native_output_oversized')
        return data

class RuntimeGuard:
    def __init__(self, operation_id=None, wait_seconds=None):
        if operation_id is not None and not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', operation_id):
            raise GuardError('runtime_guard_operation_invalid')
        self.operation_id = operation_id
        self.wait_seconds = (600 if operation_id is None else 0) if wait_seconds is None else wait_seconds
        if not isinstance(self.wait_seconds, (int, float)) or not 0 <= self.wait_seconds <= 600:
            raise GuardError('runtime_guard_wait_invalid')
        self.stream = None

    def __enter__(self):
        if os.geteuid() != OWNER_UID:
            raise GuardError('runtime_guard_root_required')
        private_directory(ROOT)
        private_directory(ROOT / 'operations')
        fd = os.open(ROOT / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        inherited = os.environ.get('COGNI_RUNTIME_GUARD_FD')
        if inherited is not None:
            try:
                inherited_fd = int(inherited)
                if not 3 <= inherited_fd <= 1024:
                    raise ValueError()
                own, parent = os.fstat(fd), os.fstat(inherited_fd)
                if (own.st_dev, own.st_ino) != (parent.st_dev, parent.st_ino):
                    raise ValueError()
                copied = os.dup(inherited_fd)
            except (OSError, ValueError):
                os.close(fd)
                raise GuardError('runtime_guard_inherited_lock_invalid') from None
            os.close(fd)
            fd = copied
        self.stream = os.fdopen(fd, 'a')
        info = os.fstat(fd)
        if info.st_uid != OWNER_UID or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            self.stream.close()
            raise GuardError('runtime_guard_lock_untrusted')
        try:
            deadline = time.monotonic() + self.wait_seconds
            while True:
                try:
                    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise GuardError('runtime_guard_busy') from None
                    time.sleep(min(0.05, max(0, deadline - time.monotonic())))
            directories = list((ROOT / 'operations').iterdir())
            if len(directories) > 1000:
                raise GuardError('runtime_guard_inventory_incomplete')
            for directory in directories:
                if directory.is_symlink() or not directory.is_dir() or directory.stat().st_uid != OWNER_UID or directory.stat().st_mode & 0o077:
                    raise GuardError('runtime_guard_journal_untrusted')
                path = directory / 'operation.json'
                # An interrupted prepare can leave private backups without a journal.
                # Only its original operation can inspect/reconcile that incomplete write.
                if not path.exists():
                    if directory.name != self.operation_id:
                        raise GuardError('runtime_activation_reconcile_required')
                    continue
                try:
                    record = json.loads(private_read(path))
                except (ValueError, OSError):
                    raise GuardError('runtime_guard_journal_invalid') from None
                if record.get('operationId') != directory.name or record.get('version') != VERSION:
                    raise GuardError('runtime_guard_journal_invalid')
                if record.get('state') not in TERMINAL:
                    if record.get('operationId') != self.operation_id:
                        raise GuardError('runtime_activation_reconcile_required')
            return self
        except BaseException:
            self.stream.close()
            self.stream = None
            raise

    def __exit__(self, *_args):
        if self.stream:
            self.stream.close()
            self.stream = None

    def exec(self, argv):
        if not self.stream or not argv:
            raise GuardError('runtime_guard_command_missing')
        os.set_inheritable(self.stream.fileno(), True)
        os.environ['COGNI_RUNTIME_GUARD_FD'] = str(self.stream.fileno())
        os.execvp(argv[0], argv)

if __name__ == '__main__':
    try:
        if len(sys.argv) < 3 or sys.argv[1] not in ('exec', 'exec-installed'):
            raise GuardError('runtime_guard_exec_only')
        with RuntimeGuard() as guard:
            if sys.argv[1] == 'exec-installed':
                validate_installation()
            guard.exec(sys.argv[2:])
    except GuardError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
