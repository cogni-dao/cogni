#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Fixed host guard for runtime publication, recovery and gateway activation (bug.5570)."""
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys

ROOT = Path('/var/lib/cogni/runtime-maintenance')
TERMINAL = {'activated', 'rolled_back'}
VERSION = 1
OWNER_UID = 0

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

class RuntimeGuard:
    def __init__(self, operation_id=None):
        if operation_id is not None and not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', operation_id):
            raise GuardError('runtime_guard_operation_invalid')
        self.operation_id = operation_id
        self.stream = None

    def __enter__(self):
        if os.geteuid() != OWNER_UID:
            raise GuardError('runtime_guard_root_required')
        private_directory(ROOT)
        private_directory(ROOT / 'operations')
        fd = os.open(ROOT / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        self.stream = os.fdopen(fd, 'a')
        info = os.fstat(fd)
        if info.st_uid != OWNER_UID or not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
            self.stream.close()
            raise GuardError('runtime_guard_lock_untrusted')
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
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
        os.execvp(argv[0], argv)

if __name__ == '__main__':
    try:
        if len(sys.argv) < 3 or sys.argv[1] != 'exec':
            raise GuardError('runtime_guard_exec_only')
        with RuntimeGuard() as guard:
            guard.exec(sys.argv[2:])
    except GuardError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
