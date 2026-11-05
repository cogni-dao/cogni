#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""One version-2 recovery receipt codec and guarded atomic writer (bug.5570)."""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile

RECEIPT = Path('/var/lib/cogni/runtime-recovery-receipt.json')
HASH = re.compile(r'[a-f0-9]{64}')
OWNER_UID = 0

class ReceiptError(RuntimeError):
    pass

def digest(data):
    return hashlib.sha256(data).hexdigest()

def canonical(value):
    # Preserve the exact existing jq -cS codec, including number and UTF-8 handling.
    proc = subprocess.run(['jq', '-cS', '.'], input=json.dumps(value).encode(),
                          stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False, timeout=10)
    if proc.returncode:
        raise ReceiptError('runtime_receipt_canonicalization_failed')
    return proc.stdout.rstrip(b'\n')

def validate(value):
    if not isinstance(value, dict) or value.get('version') != 2:
        raise ReceiptError('runtime_receipt_version_invalid')
    core = {k:v for k,v in value.items() if k != 'declarationDigest'}
    if digest(canonical(core)) != value.get('declarationDigest'):
        raise ReceiptError('runtime_receipt_digest_invalid')
    for key in ['composeSha256', 'litellmConfigSha256', 'recoveryServiceConfigSha256']:
        if not HASH.fullmatch(value.get(key, '')):
            raise ReceiptError('runtime_receipt_shape_invalid')
    images = value.get('images')
    if not isinstance(images, dict) or set(images) != {'postgres','litellm','autoheal'}:
        raise ReceiptError('runtime_receipt_images_invalid')
    for image in images.values():
        if not isinstance(image, dict) or not image.get('ref') or not re.fullmatch(r'sha256:[a-f0-9]{64}', image.get('id','')):
            raise ReceiptError('runtime_receipt_images_invalid')
    for key in ['sourceRef', 'completedAt']:
        if not isinstance(value.get(key), str) or not value[key] or len(value[key]) > 512:
            raise ReceiptError('runtime_receipt_shape_invalid')
    return value

def seal(core):
    core = {k:v for k,v in core.items() if k != 'declarationDigest'}
    return validate({**core, 'declarationDigest':digest(canonical(core))})

def atomic(path, data):
    fd, temp = tempfile.mkstemp(prefix='.'+path.name+'.', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data); f.flush(); os.fsync(f.fileno())
        os.chmod(temp,0o600);os.replace(temp,path)
        directory = os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY)
        try:os.fsync(directory)
        finally:os.close(directory)
    finally:
        if os.path.exists(temp):os.unlink(temp)

def read_bytes():
    fd = os.open(RECEIPT, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != OWNER_UID or info.st_mode & 0o077 or info.st_size > 65536:
            raise ReceiptError('runtime_receipt_file_untrusted')
        with os.fdopen(fd, 'rb', closefd=False) as stream:
            return stream.read(65537)
    finally:
        os.close(fd)

def read():
    return validate(json.loads(read_bytes()))

def commit(value, expected_file_hash):
    value=validate(value)
    if expected_file_hash is None:
        if RECEIPT.exists() or RECEIPT.is_symlink():
            raise ReceiptError('runtime_receipt_already_exists')
    elif digest(read_bytes()) != expected_file_hash:
        raise ReceiptError('runtime_receipt_changed')
    atomic(RECEIPT, canonical(value)+b'\n')
    return digest(read_bytes())

if __name__ == '__main__':
    try:
        if sys.argv[1:] == ['seal']:
            print(canonical(seal(json.load(sys.stdin))).decode())
        elif sys.argv[1:] == ['validate']:
            validate(json.load(sys.stdin));print('valid')
        elif len(sys.argv) == 3 and sys.argv[1] == 'commit':
            print(commit(json.load(sys.stdin), None if sys.argv[2] == 'absent' else sys.argv[2]))
        elif sys.argv[1:] == ['config-hash']:
            config = json.load(sys.stdin)
            print(digest(canonical({'services': {name: config['services'][name]
                                                for name in ('postgres', 'litellm', 'autoheal')}})))
        else:raise ReceiptError('runtime_receipt_command_invalid')
    except (ReceiptError,ValueError,KeyError,TypeError) as error:
        print(str(error) if isinstance(error,ReceiptError) else 'runtime_receipt_invalid',file=sys.stderr)
        raise SystemExit(1)
