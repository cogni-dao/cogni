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
import types

BASE = Path(__file__).absolute().parent
sys.dont_write_bytecode = True
ROOT = Path('/var/lib/cogni-host-admission')
POLICY = Path('/etc/cogni-host-admission/policy.json')
OWNER = 'control'
Rejected = RuntimeError  # Signal refusal is available before verified siblings load.
CONTEXT = {'runId': str(uuid.uuid4()), 'sourceSha': None, 'manifestDigest': None, 'operation': 'admission'}


def trusted(path, directory=False):
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
        raise Rejected('untrusted_path')
    if directory != stat.S_ISDIR(info.st_mode):
        raise Rejected('path_type')


def interrupted(_signum, _frame):
    raise Rejected('operation_interrupted')


def verified_source():
    """Stdlib-only bootstrap; no sibling search path or code before trust checks."""
    base = Path(__file__).absolute().parent
    def read_regular(path, cap=65536):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
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


def perform(engine, owner, request):
    return engine.execute(owner, request)


def main():
    if len(sys.argv) != 1 or os.environ.get('SSH_ORIGINAL_COMMAND') or os.geteuid() != 0:
        raise RuntimeError('entrypoint_boundary')
    for name in ('PYTHONPATH', 'PYTHONHOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'BASH_ENV', 'ENV'):
        if name in os.environ:
            raise RuntimeError('caller_environment')
    # The operation's single 12s budget includes bootstrap, policy and work.
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT, signal.SIGALRM):
        signal.signal(sig, interrupted)
    signal.alarm(12)
    global Rejected
    _, manifest, manifest_digest, modules = verified_source()
    Rejected = modules['admission'].Rejected
    Engine, Policy = modules['admission'].Engine, modules['admission'].Policy
    locked, parse, receive = modules['admission'].locked, modules['admission'].parse, modules['admission'].receive
    Kernel = modules['kernel'].Kernel
    # Fixed policy/state paths are checked only after the verified code closure.
    for target in (BASE, POLICY.parent, ROOT):
        for parent in (target, *target.parents):
            trusted(parent, directory=True)
    trusted(POLICY)
    for file in ('entrypoint.py', 'wrapper.py', 'admission.py', 'kernel.py'):
        trusted(BASE / file)
    CONTEXT.update(sourceSha=manifest['sourceSha'], manifestDigest=manifest_digest)
    fd = os.open(POLICY, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise Rejected('untrusted_policy_file')
        raw_policy = os.read(fd, 32769)
        if len(raw_policy) > 32768:
            raise Rejected('policy_overflow')
    finally:
        os.close(fd)
    policy = Policy(json.loads(raw_policy))
    with locked(ROOT):
        raw = receive(0)
        request = parse(raw, policy, OWNER, time.time())
        CONTEXT['operation'] = request['operation']
        response = perform(Engine(policy, ROOT, Kernel(policy)), OWNER, request)
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
