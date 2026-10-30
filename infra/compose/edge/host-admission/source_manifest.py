#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Trusted runner: attest committed host bytes independently of app /version.

Run from the reviewed repository root; no caller source/command/path selection.
stdout is public digests only. source.json is a delivery artifact, never policy.
"""
import hashlib
import json
import os
import stat
import subprocess

FILES = ('admission.py', 'kernel.py', 'entrypoint.py', 'wrapper.py',
         'integration_selftest.py', 'source_manifest.py', 'test_delivery.py',
         'fixtures/compatible-v1/admission.py', 'fixtures/compatible-v1/manifest.json')
PREFIX = 'infra/compose/edge/host-admission/'


def main():
    sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], timeout=2).decode().strip()
    digests = {}
    for name in FILES:
        committed = subprocess.check_output(['git', 'show', sha+':'+PREFIX+name], timeout=2)
        fd = os.open(PREFIX+name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise RuntimeError('nonregular host source')
            local = os.read(fd, 262145)
            if len(local) > 262144:
                raise RuntimeError('host source overflow')
            if committed != local:
                raise RuntimeError('uncommitted host source: '+name)
        finally:
            os.close(fd)
        digests[name] = hashlib.sha256(committed).hexdigest()
    print(json.dumps({'sourceSha': sha, 'files': digests}, sort_keys=True))


if __name__ == '__main__':
    main()
