#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""Fixed installed-runtime recovery caller; no custody, pull or source selection."""
import importlib.util
import json
from pathlib import Path
import sys
import time

LIB = Path(__file__).resolve().parent
RUNTIME = Path('/opt/cogni-template-runtime')

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), LIB / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

guard = load('runtime-maintenance-guard')
receipt = load('runtime-recovery-receipt')
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
COMPOSE = DOCKER + ['compose', '--project-name', 'cogni-runtime', '--env-file', str(RUNTIME / '.env'),
                    '-f', str(RUNTIME / 'docker-compose.yml')]
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
ACTIVE_GUARD_FD = None

def run(argv, timeout=20):
    return guard.run_native(ACTIVE_GUARD_FD, argv, timeout=timeout, env=ENV, cwd=RUNTIME)

def recover():
    global ACTIVE_GUARD_FD
    # Journal admission precedes receipt validation and every container effect.
    with guard.RuntimeGuard(wait_seconds=120) as active_guard:
        ACTIVE_GUARD_FD = active_guard.stream.fileno()
        try:
            guard.validate_installation()
            value = receipt.read()
            for name, field in [('docker-compose.yml', 'composeSha256'), ('configs/litellm.config.yaml', 'litellmConfigSha256')]:
                path = RUNTIME / name
                if path.is_symlink() or receipt.digest(path.read_bytes()) != value[field]:
                    raise ValueError()
            config = json.loads(run(COMPOSE + ['config', '--format', 'json']))
            selected = {'services': {s: config['services'][s] for s in ('postgres', 'litellm', 'autoheal')}}
            if receipt.digest(receipt.canonical(selected)) != value['recoveryServiceConfigSha256']:
                raise ValueError()
            for name, image in value['images'].items():
                observed = json.loads(run(DOCKER + ['image', 'inspect', image['ref']]))[0]['Id']
                if config['services'][name]['image'] != image['ref'] or observed != image['id']:
                    raise ValueError()
        except Exception:
            return {'state': 'custody_required'}
        for service, budget in [('postgres', 120), ('litellm', 180), ('autoheal', 60)]:
            run(COMPOSE + ['up', '-d', '--no-deps', '--pull', 'never', '--no-build', service], timeout=60)
            deadline = time.monotonic() + budget
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError('runtime_recovery_not_healthy')
                ids = run(COMPOSE + ['ps', '--all', '-q', service], timeout=min(10, remaining / 2)).decode().split()
                if len(ids) != 1:
                    raise RuntimeError('runtime_recovery_identity_missing')
                state = json.loads(run(DOCKER + ['inspect', ids[0]], timeout=min(10, remaining / 2)))[0]['State']
                if state.get('Running') and (state.get('Health', {}).get('Status') == 'healthy' or
                                             (service == 'autoheal' and not state.get('Health'))):
                    break
                if state.get('Status') in ('dead', 'exited'):
                    raise RuntimeError('runtime_recovery_not_healthy')
                time.sleep(min(2, max(0, deadline - time.monotonic())))
        return {'state': 'recovered', 'receiptSha256': value['declarationDigest']}

if __name__ == '__main__':
    try:
        if sys.argv[1:]:
            raise RuntimeError('runtime_recovery_takes_no_arguments')
        print(json.dumps(recover()))
    except Exception:
        print('runtime_recovery_incomplete', file=sys.stderr)
        raise SystemExit(1)
