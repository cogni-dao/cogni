#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""Install the fixed shared guard before ordinary runtime writers use it.

This is not gateway enablement. Qualify the native lock/journal algorithm in a
private inert namespace, migrate the one owned recovery caller, and publish the
source manifest under the actual host guard. No runtime render/container changes.
"""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import uuid

LIB = Path(__file__).resolve().parent
OWNER_UID = 0

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), LIB / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

guard = load('runtime-maintenance-guard')
receipt = load('runtime-recovery-receipt')
FILES = guard.HELPER_FILES
UNIT_NAME = 'cogni-runtime-recovery.service'
UNIT_FILE = Path('/etc/systemd/system') / UNIT_NAME
UNIT = '''[Unit]
Description=Cogni receipt-validated installed runtime recovery
After=docker.service k3s.service

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /var/lib/cogni/runtime-maintenance/lib/runtime-recovery-host.py
TimeoutStartSec=900
'''

def require(condition):
    if not condition:
        raise RuntimeError('runtime_guard_install_refused')

def qualify_algorithm():
    original_root = guard.ROOT
    inherited = os.environ.pop('COGNI_RUNTIME_GUARD_FD', None)
    try:
        with tempfile.TemporaryDirectory(prefix='guard-proof.', dir=original_root) as scratch:
            guard.ROOT = Path(scratch)
            with guard.RuntimeGuard(wait_seconds=0):
                try:
                    with guard.RuntimeGuard(wait_seconds=0):
                        raise RuntimeError('runtime_guard_exclusion_failed')
                except guard.GuardError as error:
                    require(str(error) == 'runtime_guard_busy')
                operation = str(uuid.uuid4())
                directory = guard.ROOT / 'operations' / operation
                guard.private_directory(directory)
                receipt.atomic(directory / 'operation.json', receipt.canonical({
                    'version': 1, 'operationId': operation, 'state': 'prepared',
                }))
            try:
                with guard.RuntimeGuard(wait_seconds=0):
                    raise RuntimeError('runtime_guard_journal_refusal_failed')
            except guard.GuardError as error:
                require(str(error) == 'runtime_activation_reconcile_required')
            with guard.RuntimeGuard(operation, wait_seconds=0):
                pass
    finally:
        guard.ROOT = original_root
        if inherited is not None:
            os.environ['COGNI_RUNTIME_GUARD_FD'] = inherited

def recover_caller():
    raw = subprocess.check_output(['systemctl', 'list-unit-files', '--no-pager', '--no-legend'], timeout=15).decode()
    names = [line.split()[0] for line in raw.splitlines() if line.strip()]
    matches = [name for name in names if name.endswith('.service') and re.search(r'runtime.*recover|recover.*runtime', name)]
    require(not any(name != UNIT_NAME for name in matches))
    if not matches:
        return None
    active = subprocess.check_output(['systemctl', 'show', UNIT_NAME, '--property=ActiveState', '--value'], timeout=15).decode().strip()
    require(active not in ('active', 'activating', 'deactivating'))
    dropins = subprocess.check_output(['systemctl', 'show', UNIT_NAME, '--property=DropInPaths', '--value'], timeout=15).decode().strip()
    require(not dropins)
    previous = subprocess.check_output(['systemctl', 'cat', UNIT_NAME], timeout=15)
    backups = guard.ROOT / 'recovery-caller-backups'
    guard.private_directory(backups)
    backup = backups / (receipt.digest(previous) + '.unit')
    if not backup.exists():
        receipt.atomic(backup, previous)
    if not UNIT_FILE.exists() or UNIT_FILE.is_symlink() or UNIT_FILE.read_bytes() != UNIT.encode():
        receipt.atomic(UNIT_FILE, UNIT.encode())
        os.chmod(UNIT_FILE, 0o644)
        subprocess.run(['systemctl', 'daemon-reload'], check=True, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, timeout=30)
    command = subprocess.check_output(['systemctl', 'show', UNIT_NAME, '--property=ExecStart', '--value'], timeout=15).decode()
    require('/var/lib/cogni/runtime-maintenance/lib/runtime-recovery-host.py' in command)
    return {'name': UNIT_NAME, 'sha256': receipt.digest(UNIT_FILE.read_bytes())}

def install(source_sha, operation_id=None):
    require(bool(re.fullmatch(r'[a-f0-9]{40}', source_sha)))
    blobs = {}
    for name in FILES:
        path = LIB / name
        require(path.is_file() and not path.is_symlink() and path.stat().st_uid == OWNER_UID and not path.stat().st_mode & 0o022)
        blobs[name] = receipt.digest(path.read_bytes())
    with guard.RuntimeGuard(operation_id):
        qualify_algorithm()
        target = guard.ROOT / 'lib'
        guard.private_directory(target)
        manifest_path = guard.ROOT / 'source.json'
        if manifest_path.exists():
            gateway = json.loads(guard.private_read(manifest_path))
            if gateway.get('blobs') != blobs:
                gateway['maintenanceEnabled'] = False
                receipt.atomic(manifest_path, receipt.canonical(gateway) + b'\n')
        for name in FILES:
            data = (LIB / name).read_bytes()
            require(receipt.digest(data) == blobs[name])
            receipt.atomic(target / name, data)
            require(receipt.digest((target / name).read_bytes()) == blobs[name])
        caller = recover_caller()
        result = {'protocolVersion': 1, 'sourceSha': source_sha, 'blobs': blobs,
                  'qualifiedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'recoveryCaller': caller}
        receipt.atomic(guard.ROOT / 'guard.json', receipt.canonical(result) + b'\n')
        return result

if __name__ == '__main__':
    try:
        require(len(sys.argv) == 3 and sys.argv[1] == 'install')
        result = install(sys.argv[2])
        print(json.dumps({'state': 'runtime_guard_installed', 'sourceSha': result['sourceSha']}))
    except Exception:
        print('runtime_guard_install_refused', file=sys.stderr)
        raise SystemExit(1)
