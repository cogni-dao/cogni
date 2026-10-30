#!/usr/bin/python3 -I
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Fixed TEST-only custody step. No regular-host activation or sibling imports.

Trusted runner uploads this bootstrap and source.json through root SSH into the
fixed root-private directory. Archive-owned bundle bytes are data only. Verify
all bytes before materializing a fresh root-owned closure for the isolated test.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import tempfile

ROOT = Path('/opt/cogni-host-admission-test-delivery')
SOURCE = Path('/opt/cogni-template-edge/host-admission')
FILES = ('admission.py', 'kernel.py', 'entrypoint.py', 'wrapper.py',
         'integration_selftest.py', 'source_manifest.py', 'test_delivery.py',
         'fixtures/compatible-v1/admission.py', 'fixtures/compatible-v1/manifest.json')


def trusted(path, directory=False):
    info = path.lstat()
    if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
        raise RuntimeError('untrusted_test_delivery')
    if directory and not stat.S_ISDIR(info.st_mode):
        raise RuntimeError('delivery_directory_type')


def read(path, root_owned=False):
    for parent in (path.parent, *path.parent.parents):
        info = parent.lstat()
        if not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('delivery_symlink_ancestor')
        if root_owned:
            trusted(parent, True)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode):
            raise RuntimeError('delivery_file_type')
        if root_owned and (info.st_uid != 0 or info.st_mode & 0o022):
            raise RuntimeError('delivery_file_custody')
        data = os.read(fd, 262145)
        if len(data) > 262144:
            raise RuntimeError('delivery_overflow')
        return data
    finally:
        os.close(fd)


def stage():
    for parent in (ROOT, *ROOT.parents):
        trusted(parent, True)
    raw = read(ROOT/'source.json', True)
    manifest = json.loads(raw)
    if set(manifest) != {'sourceSha', 'files'} or not re.fullmatch('[0-9a-f]{40}', manifest['sourceSha']) or set(manifest['files']) != set(FILES):
        raise RuntimeError('delivery_manifest')
    if hashlib.sha256(read(ROOT/'test_delivery.py', True)).hexdigest() != manifest['files']['test_delivery.py']:
        raise RuntimeError('delivery_bootstrap_digest')
    closure = {name: read(SOURCE/name) for name in FILES}
    for name, data in closure.items():
        if hashlib.sha256(data).hexdigest() != manifest['files'][name]:
            raise RuntimeError('delivery_digest:'+name)
    # Fresh directory; never reuse an earlier mutable archive or follow a link.
    destination = Path(tempfile.mkdtemp(prefix='closure-', dir=ROOT/'runs'))
    try:
        for name, data in {**closure, 'source.json': raw}.items():
            target = destination/name
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            trusted(target)
            for parent in target.parents:
                trusted(parent, True)
                if parent == ROOT:
                    break
        import syslog
        row = json.dumps({'operation': 'test-source-delivery', 'sourceSha': manifest['sourceSha'],
                          'manifestDigest': hashlib.sha256(raw).hexdigest(),
                          'archiveUids': sorted({(SOURCE/name).stat().st_uid for name in FILES}),
                          'stagedUid': destination.stat().st_uid, 'verdict': 'verified'}, sort_keys=True)
        syslog.openlog('cogni-host-admission', syslog.LOG_PID, syslog.LOG_AUTHPRIV)
        syslog.syslog(syslog.LOG_INFO, row)
        print(row, flush=True)
        return destination
    except BaseException:
        import shutil
        shutil.rmtree(destination)
        raise



def custody_cases(destination):
    """Harmless pre-setup falsifiers using real root custody and isolated Python."""
    import shutil
    import subprocess
    probe = Path(tempfile.mkdtemp(prefix='custody-', dir=ROOT/'runs'))
    marker = probe/'UNMANIFESTED_EFFECT'
    package = probe/'bundle'
    try:
        shutil.copytree(destination, package)
        evil = ('from pathlib import Path;Path('+repr(str(marker))+').touch()').encode()
        (package/'kernel.py').write_bytes(evil)
        refused = subprocess.run(['/usr/bin/python3', '-I', str(package/'integration_selftest.py')],
                                 capture_output=True, timeout=2)
        if refused.returncode == 0 or b'source_digest' not in refused.stdout or marker.exists():
            raise RuntimeError('modified_module_not_refused_before_setup')
        shutil.copyfile(destination/'kernel.py', package/'kernel.py')
        (package/'ctypes.py').write_bytes(evil)
        # Load the real closure only, without entering preflight or namespaces.
        code = "import runpy; m=runpy.run_path("+repr(str(package/'integration_selftest.py'))+");m['load_verified_bundle']()"
        loaded = subprocess.run(['/usr/bin/python3', '-I', '-c', code], capture_output=True, timeout=2)
        if loaded.returncode or marker.exists():
            raise RuntimeError('unmanifested_sibling_imported')
    finally:
        shutil.rmtree(probe)


def validate_bootstrap():
    if os.geteuid() != 0 or Path(__file__).absolute() != ROOT/'test_delivery.py':
        raise RuntimeError('fixed_test_delivery_boundary')
    raw = read(ROOT/'source.json', True)
    manifest = json.loads(raw)
    if set(manifest) != {'sourceSha', 'files'} or set(manifest['files']) != set(FILES) or not re.fullmatch('[0-9a-f]{40}', manifest['sourceSha']):
        raise RuntimeError('delivery_manifest')
    if hashlib.sha256(read(ROOT/'test_delivery.py', True)).hexdigest() != manifest['files']['test_delivery.py']:
        raise RuntimeError('delivery_bootstrap_digest')


def main():
    validate_bootstrap()
    if len(sys.argv) != 1 or os.geteuid() != 0 or Path(__file__).absolute() != ROOT/'test_delivery.py':
        raise RuntimeError('fixed_test_delivery_boundary')
    # The kernel owns temporary source lifetime even if this PID is SIGKILLed.
    # The original SSH process becomes unshare; --kill-child binds namespace PID1.
    runs = ROOT/'runs'
    runs.mkdir(mode=0o700, exist_ok=True)
    trusted(runs, True)
    os.execv('/usr/bin/unshare', namespace_argv())


def namespace_argv():
    return ['/usr/bin/unshare', '--mount', '--propagation', 'private', '--pid',
            '--fork', '--mount-proc', '--kill-child=SIGKILL',
            '/usr/bin/python3', '-I', str(ROOT/'test_delivery.py'), '--private']


def private_main(cancellation_proof=True):
    validate_bootstrap()
    if os.getpid() != 1 or len(sys.argv) != 2 or sys.argv[1] != '--private':
        raise RuntimeError('private_delivery_pid_namespace_required')
    trusted(ROOT/'runs', True)
    import subprocess
    subprocess.run(['/usr/bin/mount', '-t', 'tmpfs', '-o', 'mode=700',
                    'h1-test-source', str(ROOT/'runs')], check=True, timeout=2)
    destination = stage()
    # Only verified source provides the existing checked parent-death mechanism.
    import runpy
    harness = runpy.run_path(str(destination/'integration_selftest.py'))
    harness['load_verified_bundle']()
    die_with_parent = sys.modules['kernel'].die_with_parent
    # Supervisor retains cleanup ownership even on cancellation or failed proof.
    import subprocess
    import shutil
    import signal
    child = None
    def cancel(signum, frame):
        raise InterruptedError('test_delivery_cancelled')
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, cancel)
    try:
        custody_cases(destination)
        if cancellation_proof:
            harness['delivery_cancellation_cases']()
        child = subprocess.Popen(['/usr/bin/python3', '-I', str(destination/'integration_selftest.py')],
                                 preexec_fn=lambda parent=os.getpid(): die_with_parent(parent))
        result = child.wait(timeout=185)
        if result:
            raise RuntimeError('isolated_test_failed:'+str(result))
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        shutil.rmtree(destination)


if __name__ == '__main__':
    if sys.argv[1:] == ['--private']:
        private_main()
    else:
        main()
