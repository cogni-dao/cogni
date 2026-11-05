#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""Install only the fixed, reviewed runtime guard library; never touch Compose.

The typed runner owns source selection and complete native-writer inventory.
This adapter verifies the staged bytes, local environment and recovery callers.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import subprocess
import sys

LIB = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), LIB / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

guard = load('runtime-maintenance-guard')
receipt = load('runtime-recovery-receipt')
installer = load('runtime-guard-install')
FILES = installer.FILES
ADMISSION_INPUTS = {'enrollmentAdapter', 'sourceAdmission', 'writerPolicy', 'dependencyLock',
                    'rootManifest', 'workspaceManifest', 'gatewayManifest', 'nodeVersion'}

def require(condition):
    if not condition:
        raise RuntimeError('gateway_guard_enrollment_refused')

def main():
    require(sys.argv[1:] == ['install'])
    raw = sys.stdin.buffer.read(16385)
    require(len(raw) <= 16384)
    manifest = json.loads(raw)
    require(set(manifest) == {'protocolVersion', 'maintenanceEnabled', 'sourceQualification', 'env', 'custodian', 'implementationSha',
                              'minimumSourceSha', 'coreSha256', 'runnerSha256', 'admissionSha256', 'blobs', 'inventorySha256', 'operationId'})
    operation_id = manifest.pop('operationId')
    require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', operation_id))
    require(manifest['protocolVersion'] == 1 and isinstance(manifest['maintenanceEnabled'], bool))
    require(manifest['env'] in ('candidate-a', 'preview', 'production'))
    require(manifest['sourceQualification'] in ('premerge', 'merged'))
    require(manifest['sourceQualification'] != 'premerge' or
            (manifest['env'] == 'candidate-a' and manifest['minimumSourceSha'] == manifest['implementationSha']))
    require(manifest['custodian']['owner'].lower() == 'cogni-dao' and manifest['custodian']['repo'].lower() == 'cogni'
            and manifest['custodian']['controlEnv'] == 'production')
    for key in ('implementationSha', 'minimumSourceSha'):
        require(re.fullmatch(r'[a-f0-9]{40}', manifest[key]))
    for key in ('coreSha256', 'runnerSha256', 'inventorySha256'):
        require(re.fullmatch(r'[a-f0-9]{64}', manifest[key]))
    require(set(manifest['admissionSha256']) == ADMISSION_INPUTS)
    for fingerprint in manifest['admissionSha256'].values():
        require(isinstance(fingerprint, str) and re.fullmatch(r'[a-f0-9]{64}', fingerprint))
    require(hashlib.sha256((LIB / 'gateway-install-host.py').read_bytes()).hexdigest() ==
            manifest['admissionSha256']['enrollmentAdapter'])
    require(set(manifest['blobs']) == set(FILES))
    for name in FILES:
        require(hashlib.sha256((LIB / name).read_bytes()).hexdigest() == manifest['blobs'][name])
    with guard.RuntimeGuard(operation_id) as active_guard:
        env = Path('/opt/cogni-template-runtime/.env').read_text()
        values = re.findall(r'(?m)^DEPLOY_ENVIRONMENT=[\'"]?([a-z-]+)[\'"]?$', env)
        require(values == [manifest['env']])
        manifest['machineId'] = Path('/etc/machine-id').read_text().strip()
        cluster = subprocess.check_output(['kubectl', '--kubeconfig', '/etc/rancher/k3s/k3s.yaml', 'get',
                                           'namespace', 'kube-system', '-o', 'json'], timeout=15)
        manifest['clusterUid'] = json.loads(cluster)['metadata']['uid']
        target = guard.ROOT / 'lib'
        guard.private_directory(target)
        previous_path = guard.ROOT / 'source.json'
        if previous_path.exists():
            previous = json.loads(guard.private_read(previous_path))
            require(previous['machineId'] == manifest['machineId'] and previous['clusterUid'] == manifest['clusterUid'])
            require(previous['env'] == manifest['env'] and previous['custodian'] == manifest['custodian'])
            require(previous.get('sourceQualification') in ('premerge', 'merged'))
            require(previous['sourceQualification'] != 'merged' or manifest['sourceQualification'] == 'merged')
            pending_directory = guard.ROOT / 'operations' / operation_id
            pending = pending_directory / 'operation.json'
            if pending_directory.exists() and (not pending.exists() or json.loads(guard.private_read(pending))['state'] not in guard.TERMINAL):
                for key in ('sourceQualification', 'implementationSha', 'minimumSourceSha', 'blobs', 'coreSha256', 'runnerSha256', 'admissionSha256'):
                    require(previous[key] == manifest[key])
                for name in FILES:
                    require(hashlib.sha256((target / name).read_bytes()).hexdigest() == previous['blobs'][name])
                print(json.dumps({'state': 'guard_retained_for_resume', 'env': manifest['env']}))
                return
            # A premerge qualification becomes a merged floor only for identical
            # implementation inputs, including the pure shared policy.
            if previous['sourceQualification'] == 'premerge' and manifest['sourceQualification'] == 'merged':
                require(previous['blobs'] == manifest['blobs'] and previous['coreSha256'] == manifest['coreSha256']
                        and previous['runnerSha256'] == manifest['runnerSha256']
                        and previous['admissionSha256'] == manifest['admissionSha256'])
        # Nested installation reuses the inherited lock description. It installs
        # and proves the guard/caller before gateway maintenance is enabled.
        os.environ['COGNI_RUNTIME_GUARD_FD'] = str(active_guard.stream.fileno())
        installed = installer.install(manifest['implementationSha'], operation_id)
        require(installed['blobs'] == manifest['blobs'])
        receipt.atomic(previous_path, receipt.canonical(manifest) + b'\n')
    print(json.dumps({'state': 'guard_enrolled', 'env': manifest['env'], 'implementationSha': manifest['implementationSha']}))

if __name__ == '__main__':
    try:
        main()
    except Exception:
        print('gateway_guard_enrollment_refused', file=sys.stderr)
        raise SystemExit(1)
