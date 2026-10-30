#!/usr/bin/python3 -I
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Fixed root entrypoint. No path/env/namespace/command or test mode inputs.

Future provisioning binds this executable to ONE owner ('control'). H1 delivers
inert capability only: no real authorized_key, policy, boot rule or activation.
"""
import hashlib
import json
import re
import uuid
import os
from pathlib import Path
import signal
import stat
import sys
import syslog
import time

# -I excludes caller Python environment and cwd. Only this trusted sibling tree.
BASE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(BASE))
from admission import Engine, Policy, Rejected, locked, parse, receive
from kernel import Kernel

ROOT = Path('/var/lib/cogni-host-admission')
POLICY = Path('/etc/cogni-host-admission/policy.json')
OWNER = 'control'
CONTEXT = {'runId': str(uuid.uuid4()), 'sourceSha': None, 'manifestDigest': None, 'operation': 'admission'}


def trusted(path, directory=False):
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
        raise Rejected('untrusted_path')
    if directory != stat.S_ISDIR(info.st_mode):
        raise Rejected('path_type')


def interrupted(_signum, _frame):
    raise Rejected('operation_interrupted')


def main():
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND') or os.geteuid() != 0:
        raise Rejected('entrypoint_boundary')
    for name in ('PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV'):
        if name in os.environ:
            raise Rejected('caller_environment')
    # Check every ancestor of the executable, policy and state roots.
    for target in (BASE, POLICY.parent, ROOT):
        for parent in (target, *target.parents):
            trusted(parent, directory=True)
    trusted(POLICY)
    for file in ('entrypoint.py', 'wrapper.py', 'admission.py', 'kernel.py'):
        trusted(BASE / file)
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGALRM):
        signal.signal(sig, interrupted)
    signal.alarm(12)
    manifest_path = BASE / 'source.json'
    trusted(manifest_path)
    manifest_raw = manifest_path.read_bytes()
    manifest = json.loads(manifest_raw)
    if not re.fullmatch(r'[0-9a-f]{40}', manifest['sourceSha']):
        raise Rejected('source_identity')
    CONTEXT.update(sourceSha=manifest['sourceSha'], manifestDigest=hashlib.sha256(manifest_raw).hexdigest())
    for name in ('entrypoint.py', 'wrapper.py', 'admission.py', 'kernel.py'):
        if hashlib.sha256((BASE/name).read_bytes()).hexdigest() != manifest['files'][name]:
            raise Rejected('source_digest')
    policy = Policy(json.loads(POLICY.read_bytes()))
    with locked(ROOT):
        raw = receive(0)
        request = parse(raw, policy, OWNER, time.time())
        CONTEXT['operation'] = request['operation']
        response = Engine(policy, ROOT, Kernel(policy)).execute(OWNER, request)
    return {**CONTEXT, **response}


if __name__ == '__main__':
    syslog.openlog('cogni-host-admission', syslog.LOG_PID, syslog.LOG_AUTHPRIV)
    try:
        result = main()
        print(json.dumps(result), flush=True)
        syslog.syslog(syslog.LOG_INFO, json.dumps({'operation': 'admission', **result}))
    except Exception as exc:
        result = {**CONTEXT, 'verdict': 'unavailable', 'detail': str(exc)[:512]}
        syslog.syslog(syslog.LOG_ERR, json.dumps(result))
        print(json.dumps(result), flush=True)
        sys.exit(1)
