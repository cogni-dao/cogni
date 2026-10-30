#!/usr/bin/python3 -I
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""NEW H1 real Linux/netns/mount/OpenSSH falsifier; trusted candidate infra only.

Outer supervisor snapshots legacy host state and verifies delivered source bytes.
Inner PID/mount/net namespaces use production paths on PRIVATE tmpfs mounts.
No real host rules, policy, keys, boot services or package installation changes.
Any missing prerequisite, assertion, cancellation or cleanup failure exits nonzero.
Native ipset TTL uses real time and NEW connections, never a mocked kernel.
"""
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import signal
import shlex
import stat
import socket
import subprocess
import sys
import syslog
import time
import uuid
import types

BASE = Path(__file__).absolute().parent
sys.dont_write_bytecode = True
FILES = ('admission.py', 'kernel.py', 'entrypoint.py', 'wrapper.py',
         'integration_selftest.py', 'source_manifest.py', 'test_delivery.py',
         'fixtures/compatible-v1/admission.py', 'fixtures/compatible-v1/manifest.json')


def verified_bundle():
    """Read the complete trusted closure before executing any sibling bytes."""
    def trusted(path, directory=False):
        info = path.lstat()
        if info.st_uid != 0 or info.st_mode & 0o022 or stat.S_ISLNK(info.st_mode):
            raise RuntimeError('untrusted_source_custody')
        if directory and not stat.S_ISDIR(info.st_mode):
            raise RuntimeError('untrusted_source_directory')
    for parent in (BASE, *BASE.parents):
        trusted(parent, True)
    def read(name):
        path = BASE/name
        for ancestor in path.parents:
            if ancestor == BASE:
                break
            trusted(ancestor, True)
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
                raise RuntimeError('untrusted_source_file')
            data = os.read(fd, 262145)
            if len(data) > 262144:
                raise RuntimeError('source_overflow')
            return data
        finally:
            os.close(fd)
    raw = read('source.json')
    manifest = json.loads(raw)
    if set(manifest) != {'sourceSha', 'files'} or not re.fullmatch('[0-9a-f]{40}', manifest['sourceSha']) or set(manifest['files']) != set(FILES):
        raise RuntimeError('source_manifest_shape')
    closure = {name: read(name) for name in FILES}
    for name, data in closure.items():
        if hashlib.sha256(data).hexdigest() != manifest['files'][name]:
            raise RuntimeError('source_digest')
    return raw, manifest, closure


def load_verified_bundle():
    raw, manifest, closure = verified_bundle()
    for name, exports in (('admission', ('Engine', 'Policy', 'Rejected', 'canonical', 'digest', 'locked', 'parse')),
                          ('kernel', ('Kernel', 'command', 'fence_rules', 'die_with_parent'))):
        module = types.ModuleType(name)
        module.__file__ = str(BASE/(name+'.py'))
        sys.modules[name] = module
        exec(compile(closure[name+'.py'], module.__file__, 'exec'), module.__dict__)
        globals().update({key: getattr(module, key) for key in exports})
    return raw, manifest

PORTS = [4000, 5432, 5435, 6379, 7233]
STATE = Path('/var/lib/cogni-host-admission')
CONFIG = Path('/etc/cogni-host-admission')
ROOT = Path('/run/h1')
PROCESSES = []
IDENTITY = {}


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def emit(operation, verdict='pass', **detail):
    row = {**IDENTITY, 'operation': operation, 'verdict': verdict, **detail}
    line = json.dumps(row, sort_keys=True)
    print(line, flush=True)
    if not '--worker' in sys.argv:
        syslog.syslog(syslog.LOG_INFO if verdict == 'pass' else syslog.LOG_ERR, line)


def run(*args, **kwargs):
    return command(list(args), **kwargs)


def namespace(kind):
    return os.readlink('/proc/self/ns/'+kind)


def source_identity():
    raw, manifest, _ = verified_bundle()
    return {'sourceSha': manifest['sourceSha'], 'manifestDigest': hashlib.sha256(raw).hexdigest(),
            'fileDigests': manifest['files'], 'runId': str(uuid.uuid4())}


def preflight():
    check(sys.platform == 'linux' and os.geteuid() == 0, 'Linux root required; no Mac kernel proof')
    evidence = {'python': sys.version.split()[0], 'kernel': os.uname().release}
    for name, argv in {
        'ipset': ['/usr/sbin/ipset', '--version'],
        'iptables': ['/usr/sbin/iptables', '--version'],
        'unshare': ['/usr/bin/unshare', '--version'],
        'ip': ['/usr/sbin/ip', '-Version'],
        'sshd': ['/usr/sbin/sshd', '-V'],
        'ssh': ['/usr/bin/ssh', '-V'],
        'mount': ['/usr/bin/mount', '--version'],
        'packages': ['/usr/bin/dpkg-query', '-W', '-f=${Package}=${Version}\n',
                     'python3', 'ipset', 'iptables', 'util-linux', 'iproute2', 'openssh-server', 'openssh-client', 'procps', 'coreutils'],
    }.items():
        evidence[name] = run(*argv)[:4096].strip()
    emit('prerequisites', versions=evidence,
         provisionPrerequisite='Fixed trusted provisioner packages: python3 ipset iptables util-linux iproute2 openssh-server openssh-client procps coreutils. No flight-time install fallback.')


def legacy_policy(raw):
    """Compare owned rules, dependencies and complete caller chains, not Kube churn.

    Whole-line save comments and chain packet counters are generated metadata.
    Rule comments, ordering, targets, chain policies and inbound hooks remain.
    """
    tables = {}
    current = None
    for line in raw.splitlines():
        if not line or line.startswith('#'):
            continue
        if line.startswith('*'):
            current = line[1:]
            tables[current] = {'chains': {}, 'rules': {}}
        elif line == 'COMMIT':
            current = None
        elif current is not None and line.startswith(':'):
            name, policy, counters = line[1:].split()
            check(re.fullmatch(r'\[\d+:\d+\]', counters), 'save chain counters')
            tables[current]['chains'][name] = policy
        elif current is not None and line.startswith('-A '):
            tokens = shlex.split(line)
            tables[current]['rules'].setdefault(tokens[1], []).append(tokens)
        else:
            raise AssertionError('unrecognized native save output')
    result = {}
    for table, data in tables.items():
        chains, rules = data['chains'], data['rules']
        def targets(rule):
            return {rule[i+1] for i, token in enumerate(rule[:-1]) if token in ('-j', '-g')}
        owned = {name for name in chains if name in ('DOCKER-USER', 'CGADMIT')}
        owned |= {name for name, rows in rules.items() if any(
            'cogni' in row[i+1].lower() for row in rows for i, token in enumerate(row[:-1]) if token == '--comment')}
        while True:
            expanded = owned | {target for name in owned for row in rules.get(name, [])
                                for target in targets(row) if target in chains}
            if expanded == owned:
                break
            owned = expanded
        # Complete callers expose an ACCEPT inserted before the admission jump.
        callers = {name for name, rows in rules.items() if any(targets(row) & owned for row in rows)}
        selected = owned | callers | ({'FORWARD'} if table == 'filter' else set())
        if selected:
            result[table] = {name: {'policy': chains[name], 'rules': rules.get(name, [])}
                             for name in sorted(selected)}
    return result


def file_fingerprint(path):
    path = Path(path)
    if not path.exists() and not path.is_symlink():
        return None
    info = path.lstat()
    # Include mode/ownership/type and link identity, not only file contents.
    value = {'mode': info.st_mode, 'uid': info.st_uid, 'gid': info.st_gid}
    if path.is_symlink():
        value['link'] = os.readlink(path)
    if path.is_file():
        value['sha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
    return value


def host_snapshot():
    # Scoped legacy policy and its full caller chains; unrelated Kube internals
    # are not this writer's state. Never read host credentials/private keys.
    files = ['/etc/iptables/rules.v4', '/etc/iptables/rules.v6',
             '/etc/cogni/compute-egress-allowlist', '/etc/cogni-compute-egress.allowlist',
             '/usr/local/sbin/cogni-harden-docker-public-ports.sh',
             '/etc/systemd/system/cogni-harden-docker-public-ports.service',
             '/opt/cogni-template-runtime/compute-egress-allowlist']
    return {'net': namespace('net'), 'mnt': namespace('mnt'),
            'rules4': legacy_policy(run('/usr/sbin/iptables-save')),
            'rules6': legacy_policy(run('/usr/sbin/ip6tables-save')),
            'files': {name: file_fingerprint(name) for name in files}}


def terminate(child):
    if child.poll() is None:
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait(timeout=2)


def outer():
    global IDENTITY
    IDENTITY = source_identity()
    preflight()
    before = host_snapshot()
    # All descendants die when this namespace's PID1 dies, even on SIGKILL.
    argv = ['/usr/bin/unshare', '--mount', '--net', '--pid', '--fork', '--mount-proc',
            '--kill-child=SIGKILL', '/usr/bin/python3', '-I', str(BASE/'integration_selftest.py'),
            '--worker', before['net'], before['mnt'], json.dumps(IDENTITY)]
    child = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             start_new_session=True, preexec_fn=lambda parent=os.getpid(): die_with_parent(parent), env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'})
    def cancel(_sig, _frame):
        raise InterruptedError('selftest canceled')
    for sig in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(sig, cancel)
    result = None
    worker_error = None
    preservation_error = None
    total = bytearray()
    progress = set()
    deadline = time.monotonic()+180
    try:
        while True:
            left = deadline-time.monotonic()
            if left <= 0 or not select.select([child.stdout], [], [], min(1, left))[0]:
                if left <= 0:
                    raise TimeoutError('isolated selftest 180s deadline')
                continue
            chunk = os.read(child.stdout.fileno(), 4096)
            if not chunk:
                break
            total.extend(chunk)
            for line in total.decode(errors='replace').splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                phase = row.get('operation')
                if phase in ('private-setup-start', 'native-preflight') and phase not in progress:
                    check(row.get('sourceSha') == IDENTITY['sourceSha'] and row.get('runId') == IDENTITY['runId'], 'progress identity')
                    progress.add(phase)
                    emit('suite-progress', 'observed', phase=phase)
            if len(total) > 262144:
                raise RuntimeError('bounded selftest output exceeded')
        result = child.wait(timeout=2)
    except BaseException as exc:
        worker_error = exc
    finally:
        try:
            os.killpg(child.pid, signal.SIGTERM)
            try:
                child.wait(timeout=2)
            except subprocess.TimeoutExpired:
                os.killpg(child.pid, signal.SIGKILL)
                child.wait(timeout=2)
        except ProcessLookupError:
            pass
        child.stdout.close()
        try:
            after = host_snapshot()
            check(before == after, 'legacy host rules/files or namespace changed')
            emit('legacy-host-unchanged', hostNet=before['net'], hostMount=before['mnt'])
        except BaseException as exc:
            preservation_error = exc
            emit('legacy-host-preservation', 'failure', detail=str(exc)[:512])
    diagnostics = False
    completions = 0
    for line in total.decode(errors='replace').splitlines():
        try:
            row = json.loads(line)
            check(row.get('sourceSha') == IDENTITY['sourceSha'] and row.get('runId') == IDENTITY['runId'], 'worker source binding')
            if row.get('operation') in ('suite', 'selftest', 'delivery') and row.get('verdict') == 'pass':
                # Worker diagnostics cannot commit an outer terminal verdict.
                diagnostics = True
                emit('worker-terminal-refused', 'failure', detail='terminal success belongs to outer supervisor')
                continue
            if row.get('operation') == 'worker-complete' and row.get('verdict') == 'complete':
                completions += 1
            syslog.syslog(syslog.LOG_INFO, json.dumps(row))
            print(json.dumps(row), flush=True)
        except (ValueError, AttributeError):
            diagnostics = True
            emit('worker-diagnostic', 'failure', detail=line[:1024])
    if worker_error is not None:
        raise worker_error
    check(result == 0 and not diagnostics, 'isolated kernel/SSH proof failed; exit='+str(result))
    if preservation_error is not None:
        raise preservation_error
    check(completions == 1, 'missing/duplicate worker assertion completion')
    # Sole terminal success, after exit/cleanup/preservation/identity/completion.
    emit('suite-complete', 'complete', result='actual-kernel-ssh-complete')


FIXED_EXECUTABLES = ('/usr/sbin/iptables', '/usr/sbin/iptables-save', '/usr/sbin/ip6tables-save',
                     '/usr/sbin/ipset', '/usr/sbin/ip', '/usr/sbin/sshd', '/usr/bin/python3',
                     '/usr/bin/mount', '/usr/bin/ssh', '/usr/bin/ssh-keygen', '/usr/bin/scp',
                     '/usr/bin/ssh-agent', '/usr/bin/ssh-add', '/usr/bin/ps', '/bin/sh')


def executable_closure():
    """Read only fixed public executable links, never copy host /etc contents."""
    links, identities = {}, {}
    for name in FIXED_EXECUTABLES:
        cursor = Path(name)
        for _ in range(16):
            if not cursor.is_symlink():
                break
            check(cursor.lstat().st_uid == 0, 'non-root executable link')
            target = os.readlink(cursor)
            if str(cursor).startswith('/etc/'):
                check(cursor.parent == Path('/etc/alternatives'), 'unapproved executable config link')
                links[str(cursor)] = target
            cursor = Path(os.path.normpath(str(cursor.parent/target))) if not target.startswith('/') else Path(target)
        else:
            raise AssertionError('executable link cycle')
        final = Path(name).resolve(strict=True)
        info = final.stat()
        check(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and not info.st_mode & 0o022,
              'untrusted executable closure '+name)
        identities[name] = {'resolved': str(final), 'sha256': hashlib.sha256(final.read_bytes()).hexdigest()}
    versions = {name: run(name, '--version').strip() for name in ('/usr/sbin/iptables', '/usr/sbin/ipset')}
    return links, identities, versions


def restore_executable_links(links):
    for name, target in links.items():
        path = Path(name)
        check(path.parent == Path('/etc/alternatives'), 'only fixed alternatives links may be restored')
        path.parent.mkdir(mode=0o755, exist_ok=True)
        path.symlink_to(target)


def isolated_tool_preflight(expected, versions):
    # Runs after private /etc replacement and BEFORE packet/link/sysctl mutation.
    for name, identity in expected.items():
        resolved = Path(name).resolve(strict=True)
        check(str(resolved) == identity['resolved'] and hashlib.sha256(resolved.read_bytes()).hexdigest() == identity['sha256'],
              'private executable closure mismatch '+name)
    observed = {name: run(name, '--version').strip() for name in versions}
    check(observed == versions, 'isolated native backend differs from outer executable')
    emit('isolated-tool-preflight', executableIdentities=expected, backends=observed)


def private_filesystem(host_net, host_mount):
    # THIS assertion precedes ANY kernel mutation, including fixture creation.
    check(namespace('net') != host_net and namespace('mnt') != host_mount, 'unsafe initial host namespace')
    check(Path('/proc/1/ns/net').readlink() == Path('/proc/self/ns/net').readlink(), 'private PID/proc binding')
    links, executables, versions = executable_closure()
    run('/usr/bin/mount', '--make-rprivate', '/')
    emit('private-setup-start', 'observed')
    # Give the native cancellation observer a bounded partial-setup window.
    time.sleep(.25)
    for path in ('/run', '/etc', '/var/lib', '/var/log', '/root', '/tmp'):
        run('/usr/bin/mount', '-t', 'tmpfs', '-o', 'mode=755', 'h1-private', path)
        if path == '/etc':
            restore_executable_links(links)
    run('/usr/bin/mount', '-t', 'devpts', '-o', 'newinstance,ptmxmode=0666,mode=0620', 'devpts', '/dev/pts')
    run('/usr/bin/mount', '--bind', str(BASE), str(BASE))
    run('/usr/bin/mount', '-o', 'remount,bind,ro', str(BASE))
    ROOT.mkdir(mode=0o700)
    STATE.mkdir(mode=0o700)
    CONFIG.mkdir(mode=0o700)
    Path('/run/sshd').mkdir(mode=0o755)
    Path('/etc/passwd').write_text('root:x:0:0:Sandbox:/run/h1/home:/bin/sh\nsshd:x:65534:65534:Privilege separation:/run/sshd:/usr/sbin/nologin\n')
    Path('/etc/group').write_text('root:x:0:\nnogroup:x:65534:\n')
    # Not a usable password, not a locked account; password auth is disabled.
    Path('/etc/shadow').write_text('root:$6$h1$no-password-auth:1:0:99999:7:::\n')
    Path('/etc/shadow').chmod(0o600)
    (ROOT/'home/.ssh').mkdir(parents=True, mode=0o700)
    (ROOT/'home/.ssh/rc').write_text('touch /run/h1/RC_EXECUTED\n')
    isolated_tool_preflight(executables, versions)
    emit('isolation', hostNet=host_net, testNet=namespace('net'), hostMount=host_mount, testMount=namespace('mnt'))


def setup_network(policy):
    run('/usr/sbin/ip', 'link', 'set', 'lo', 'up')
    for peer, hostdev, remote, hostip, peerip in [
            ('client', 'wan', 'c0', '8.8.8.1/24', '8.8.8.2/24'),
            ('server', 'lan', 's0', '10.80.0.1/24', '10.80.0.2/24')]:
        run('/usr/sbin/ip', 'netns', 'add', peer)
        run('/usr/sbin/ip', 'link', 'add', hostdev, 'type', 'veth', 'peer', 'name', remote)
        run('/usr/sbin/ip', 'link', 'set', remote, 'netns', peer)
        run('/usr/sbin/ip', 'addr', 'add', hostip, 'dev', hostdev)
        run('/usr/sbin/ip', 'link', 'set', hostdev, 'up')
        for args in [('link', 'set', 'lo', 'up'), ('addr', 'add', peerip, 'dev', remote),
                     ('link', 'set', remote, 'up'), ('route', 'add', 'default', 'via', hostip.split('/')[0])]:
            run('/usr/sbin/ip', '-n', peer, *args)
    run('/usr/sbin/ip', 'addr', 'add', '192.0.2.1/32', 'dev', 'wan')
    run('/usr/sbin/ip', 'addr', 'add', '192.0.2.2/32', 'dev', 'wan')
    # These network sysctls belong to this asserted private net namespace.
    Path('/proc/sys/net/ipv4/ip_forward').write_text('1')
    Path('/proc/sys/net/ipv4/conf/all/rp_filter').write_text('0')
    Path('/proc/sys/net/ipv4/conf/wan/rp_filter').write_text('0')
    for chain in ('DOCKER-USER', 'CGADMIT'):
        run('/usr/sbin/iptables', '-N', chain)
    run('/usr/sbin/iptables', '-P', 'FORWARD', 'DROP')
    run('/usr/sbin/iptables', '-A', 'FORWARD', '-j', 'DOCKER-USER')
    run('/usr/sbin/iptables', '-A', 'FORWARD', '-m', 'conntrack', '--ctstate', 'ESTABLISHED,RELATED', '-j', 'ACCEPT')
    run('/usr/sbin/iptables', '-A', 'DOCKER-USER', '-j', 'CGADMIT')
    for port in policy.ports:
        run('/usr/sbin/ipset', 'create', f'cga{port}', 'hash:ip', 'family', 'inet', 'timeout', '600', 'maxelem', '128')
    for rule in fence_rules(policy):
        run('/usr/sbin/iptables', '-A', 'CGADMIT', *rule)
    for port in [*policy.ports, 8080]:
        backend = 5432 if port == 5435 else port
        run('/usr/sbin/iptables', '-t', 'nat', '-A', 'PREROUTING', '-i', 'wan', '-p', 'tcp',
            '--dport', str(port), '-j', 'DNAT', '--to-destination', '10.80.0.2:'+str(backend))
    code = '''import socket,select
s=[]
for p in [4000,5432,6379,7233,8080]:
 x=socket.socket();x.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1);x.bind(('0.0.0.0',p));x.listen(64);s.append(x)
while True:
 for x in select.select(s,[],[],1)[0]:
  c,a=x.accept();c.close()
'''
    child = subprocess.Popen(['/usr/sbin/ip', 'netns', 'exec', 'server', '/usr/bin/python3', '-c', code])
    PROCESSES.append(child)
    time.sleep(.15)
    check(child.poll() is None, 'backend listener')
    Kernel(policy).fence()
    emit('native-preflight', result='netns-veth-nat-ipset-conntrack-fence-installed-in-sandbox')


def probe(port, allowed, destination='192.0.2.1'):
    code = "import socket,sys;s=socket.socket();s.settimeout(.18);r=s.connect_ex((sys.argv[1],int(sys.argv[2])));print('yes' if r==0 else 'no');s.close()"
    actual = run('/usr/sbin/ip', 'netns', 'exec', 'client', '/usr/bin/python3', '-c', code, destination, str(port)).strip() == 'yes'
    check(actual == allowed, f'NEW connection {destination}:{port}: allowed={actual} expected={allowed}')


def request(entries, seq=1, owner='control'):
    return {'version': 1, 'operation': 'apply', 'writerEpoch': 'epoch-'+owner,
            'expectedSequence': seq-1, 'nextSequence': seq, 'snapshotHash': digest(entries), 'entries': entries}


def entry(port=5435, ttl=40, ip='8.8.8.2'):
    return {'ipv4': ip, 'publishedPort': port, 'expiresAt': math.floor(time.time())+ttl}


def apply(engine, body, owner='control'):
    with locked(STATE):
        return engine.execute(owner, parse(canonical(body), engine.policy, owner, time.time()))


def read(engine, owner='control'):
    return apply(engine, {'version': 1, 'operation': 'read', 'writerEpoch': 'epoch-'+owner}, owner)


def rejected(function):
    try:
        function()
    except Rejected:
        return
    raise AssertionError('negative control unexpectedly accepted')


def reset(policy):
    for name in ('checkpoint.json', 'lock'):
        (STATE/name).unlink(missing_ok=True)
    kernel = Kernel(policy)
    kernel.reconcile({p: {} for p in policy.ports})
    return Engine(policy, STATE, kernel)


def fence_order_case(policy):
    engine = reset(policy)
    body = request([entry()])
    apply(engine, body)
    rules = fence_rules(policy)
    # Only this already-asserted private net namespace is modified.
    try:
        run('/usr/sbin/iptables', '-F', 'CGADMIT')
        for rule in (rules[1], rules[0], *rules[2:]):
            run('/usr/sbin/iptables', '-A', 'CGADMIT', *rule)
        for action in (lambda: read(engine), lambda: apply(engine, body)):
            rejected(action)
            check(engine.load()['pending'], 'reordered fence retired pending')
        probe(5435, False)
    finally:
        run('/usr/sbin/iptables', '-F', 'CGADMIT')
        for rule in rules:
            run('/usr/sbin/iptables', '-A', 'CGADMIT', *rule)
    read(engine)
    check(not engine.load()['pending'], 'restored sandbox fence did not repair')
    probe(5435, True)
    emit('ordered-fence-negative', result='drop-before-accept-unavailable;pending-retained;restored')


def delivery_cancellation_cases():
    """Kill the actual delivery PID1 while its real suite reaches each phase."""
    global IDENTITY
    IDENTITY = source_identity()
    import runpy
    delivery = runpy.run_path(str(BASE/'test_delivery.py'))
    delivery_root = delivery['ROOT']
    def descendants(pid):
        found = []
        try:
            children = Path(f'/proc/{pid}/task/{pid}/children').read_text().split()
        except FileNotFoundError:
            return found
        for child in children:
            found.append(int(child))
            found.extend(descendants(int(child)))
        return found
    for phase, target in ((phase, target) for phase in ('private-setup-start', 'native-preflight') for target in ('launcher', 'enclosing-owner')):
        before = host_snapshot()
        sources = sorted(str(p) for p in (delivery_root/'runs').iterdir())
        # Real highest launcher, its real native namespace and suite. Only
        # recursive cancellation instrumentation is omitted by a Python seam.
        code = ("import runpy,sys;sys.argv=["+repr(str(delivery_root/'test_delivery.py'))+"];"
                "m=runpy.run_path(sys.argv[0]);m['main'](False)")
        argv = ['/usr/bin/python3', '-I', '-c', code]
        owner = "import subprocess,sys;child=subprocess.Popen("+repr(argv)+");sys.exit(child.wait())"
        child = subprocess.Popen(['/usr/bin/python3', '-I', '-c', owner], stdout=subprocess.PIPE,
                                 stderr=subprocess.STDOUT, start_new_session=True,
                                 preexec_fn=lambda parent=os.getpid(): die_with_parent(parent))
        data = bytearray()
        killed = False
        try:
            deadline = time.monotonic()+20
            while time.monotonic() < deadline:
                if not select.select([child.stdout], [], [], .1)[0]:
                    continue
                chunk = os.read(child.stdout.fileno(), 4096)
                check(bool(chunk), 'delivery exited before cancellation phase')
                data.extend(chunk)
                check(len(data) < 262144, 'cancellation output bound')
                rows = []
                for line in data.decode(errors='replace').splitlines():
                    try:
                        rows.append(json.loads(line))
                    except ValueError:
                        pass
                if any(row.get('operation') == 'suite-progress' and row.get('phase') == phase for row in rows):
                    tree = descendants(child.pid)
                    check(bool(tree), 'delivery namespace PID1 missing')
                    delivery_pid = tree[0] if target == 'launcher' else child.pid
                    workers = []
                    for pid in tree:
                        try:
                            args = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                            if args[0] == b'/usr/bin/python3' and b'--worker' in args:
                                workers.append(pid)
                        except FileNotFoundError:
                            pass
                    check(len(workers) == 1, 'actual suite worker not identified')
                    ready = Path(f'/proc/{workers[0]}/root/run/h1').exists()
                    check(ready == (phase == 'native-preflight'), 'cancellation missed actual setup/native phase')
                    start = time.monotonic()
                    os.kill(delivery_pid, signal.SIGKILL)
                    killed = True
                    check(child.wait(timeout=2) != 0, 'killed delivery reported success')
                    data.extend(child.communicate(timeout=2)[0])
                    for pid in tree:
                        status = Path(f'/proc/{pid}/stat')
                        while status.exists():
                            try:
                                if status.read_text().split(') ', 1)[1].startswith('Z '):
                                    break
                            except FileNotFoundError:
                                break
                            check(time.monotonic()-start < 2, 'delivery descendant survived')
                            time.sleep(.01)
                    check(time.monotonic()-start < 2, 'delivery cancellation exceeded grace')
                    break
            check(killed, 'actual delivery phase not exercised')
            for line in data.decode(errors='replace').splitlines():
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                check(not (row.get('operation') in ('suite', 'selftest', 'delivery') and row.get('verdict') == 'pass'), 'terminal PASS after failed delivery')
            check(sorted(str(p) for p in (delivery_root/'runs').iterdir()) == sources, 'temporary source lifetime escaped mount namespace')
            check(host_snapshot() == before, 'delivery cancellation changed original host state')
        finally:
            if child.poll() is None:
                child.kill()
                child.wait(timeout=2)
            child.stdout.close()
        emit('delivery-cancellation', phase=phase, target=target, result='actual-delivery-SIGKILL;descendants-dead;no-terminal-pass;source-mount-released;host-preserved')


def kernel_cases(policy):
    engine = reset(policy)
    probe(5435, False)
    r = request([entry()])
    apply(engine, r)
    probe(5435, True)
    probe(5432, False)  # DNAT to 5432 must NOT inherit an original 5432 grant.
    probe(8080, False)
    probe(5435, False, '192.0.2.2')
    before = engine.load()
    for edit in ({'owner': 'other'}, {'destination': '192.0.2.2'}, {'writerEpoch': 'wrong'},
                 {'entries': [entry(8080)]}):
        bad = {**r, **edit}
        rejected(lambda: apply(engine, bad))
    apply(engine, r)
    check(engine.load()['owners']['control']['sequence'] == 1, 'exact replay advanced sequence')
    apply(engine, request([entry(5432)], 2))
    rejected(lambda: apply(engine, r))
    rejected(lambda: apply(engine, request([entry(5435)], 2)))
    probe(5432, True)
    probe(5435, False)
    emit('original-port-cas-negative', result='5435-to-5432-separated;8080-denied;stale/conflict-denied')

    # Shared IP MAX absolute expiry; another owner refreshing cannot revive dead owner.
    engine = reset(policy)
    short, long = entry(5432, 6), entry(5432, 11)
    apply(engine, request([short]))
    apply(engine, request([long], owner='other'), 'other')
    probe(5432, True)
    time.sleep(max(0, short['expiresAt']-time.time()+.2))
    probe(5432, True)
    # No helper call at all between last grant and NEW connection denial.
    time.sleep(max(0, long['expiresAt']-time.time()+1.1))
    probe(5432, False)
    check(read(engine)['sequence'] == 1, 'expiry reset CAS')
    emit('real-clock-expiry', result='shared-owner-max;dead-owner-expired-without-invocation')

    engine = reset(policy)
    entries = [entry(5432, ip='8.1.1.'+str(i)) for i in range(1,129)]
    apply(engine, request(entries))
    checkpoint = (STATE/'checkpoint.json').read_bytes()
    rejected(lambda: apply(engine, request([entry(5432)], owner='other'), 'other'))
    rejected(lambda: apply(engine, request(entries+[entry()], 2)))
    check((STATE/'checkpoint.json').read_bytes() == checkpoint, 'overflow committed a truncated snapshot')
    emit('native-overflow', result='owner-and-all-owner-sentinel-rejected-before-commit')

    # Real crash after durable commit and between EACH per-original-port swap.
    for failpoint, crash_signal in [('before-commit', signal.SIGKILL), ('after-fsync', signal.SIGTERM),
                                     ('after-fsync', signal.SIGKILL), *[(p, signal.SIGKILL) for p in policy.ports]]:
        engine = reset(policy)
        old = request([entry(5432)])
        apply(engine, old)
        replacement = request([entry(p, 55) for p in policy.ports], 2)
        pid = os.fork()
        if pid == 0:
            class CrashKernel(Kernel):
                def swapped(self, port):
                    self.fence()
                    probe(8080, False)
                    probe(5435, False, '192.0.2.2')
                    if failpoint == port:
                        os.kill(os.getpid(), crash_signal)
            class CrashEngine(Engine):
                def save(self, value):
                    if value['pending'] and failpoint == 'before-commit':
                        os.kill(os.getpid(), crash_signal)
                    super().save(value)
                    if value['pending'] and failpoint == 'after-fsync':
                        os.kill(os.getpid(), crash_signal)
            try:
                apply(CrashEngine(policy, STATE, CrashKernel(policy)), replacement)
            except BaseException:
                os._exit(78)
            os._exit(79)
        _, status = os.waitpid(pid, 0)
        check(os.waitstatus_to_exitcode(status) == -crash_signal, 'failpoint did not execute: '+str(failpoint))
        state = engine.load()
        check(state['owners']['control']['sequence'] == (1 if failpoint == 'before-commit' else 2), 'crash CAS')
        if failpoint != 'before-commit':
            check(state['pending'], 'crash lost pending')
        Kernel(policy).fence()
        probe(8080, False)
        read(engine)
        if failpoint != 'before-commit':
            for p in policy.ports:
                probe(p, True)
            apply(engine, replacement)
        check(not engine.load()['pending'], 'read repair falsely reports pending')
        emit('crash-repair', failpoint=str(failpoint), signal=crash_signal, sequence=engine.load()['owners']['control']['sequence'])

    # Native fault after a real swap: independent readback must refuse applied.
    engine = reset(policy)
    class CorruptReadback(Kernel):
        def swapped(self, port):
            if port == 5432:
                self.run('ipset', 'del', 'cga5432', '8.8.8.2')
    broken = Engine(policy, STATE, CorruptReadback(policy))
    rejected(lambda: apply(broken, request([entry(5432)])))
    check(engine.load()['pending'], 'native readback failure erased pending')
    Kernel(policy).fence()
    read(engine)
    probe(5432, True)
    emit('native-readback-failure', result='unavailable-then-read-repair')

    # Reboot reconstruction only; rollback is a separately pinned executable case.
    engine = reset(policy)
    r = request([entry(5432, 12)])
    apply(engine, r)
    for p in policy.ports:
        run('/usr/sbin/ipset', 'flush', f'cga{p}')
    rebooted = Engine(policy, STATE, Kernel(policy), boot=lambda: 'simulated-new-boot')
    check(read(rebooted)['verdict'] == 'fresh_snapshot_required', 'preboot grants admitted without time continuity')
    check(rebooted.load()['owners']['control']['sequence'] == 1, 'reboot decreased sequence')
    apply(rebooted, r)
    probe(5432, False)
    apply(rebooted, request([entry(5432, 12)], 2))
    probe(5432, True)
    check(Kernel(policy).read(5432)['8.8.8.2'] <= rebooted.load()['owners']['control']['entries'][0]['expiresAt']-time.time(),
          'fresh reboot snapshot extended native lifetime')
    # Inject only test-side clocks; kernel remains REAL. No host clock mutation.
    back = Engine(policy, STATE, Kernel(policy), clock=lambda: time.time()-100, boot=lambda: 'simulated-new-boot')
    rejected(lambda: read(back))
    probe(5432, False)
    forward = Engine(policy, STATE, Kernel(policy), clock=lambda: time.time()+700, boot=lambda: 'simulated-new-boot')
    read(forward)
    probe(5432, False)
    emit('reboot-clock', result='absolute-expiry-preserved;backward-fails-closed;forward-expires')


def repair_fault_cases(policy):
    """Actual kernel repair at every port, independent of desired/applied hash."""
    engine = reset(policy)
    body = request([entry(p, 90) for p in policy.ports])
    apply(engine, body)
    writes = []
    class NoopKernel(Kernel):
        def run(self, tool, *args, **kwargs):
            if tool == 'ipset' and args[0] in ('create', 'flush', 'restore', 'swap'):
                writes.append(args)
            return super().run(tool, *args, **kwargs)
    apply(Engine(policy, STATE, NoopKernel(policy)), body)
    check(not writes, 'unchanged exact replay performed kernel writes')
    emit('native-noop', result='same-input-exact-replay-zero-kernel-mutation')
    for mode in ('read', 'exact-replay', 'reboot', 'backward-clock'):
        for port in policy.ports:
            for fault in ('SIGKILL', 'readback'):
                engine = reset(policy)
                r = request([entry(p, 90) for p in policy.ports])
                apply(engine, r)
                before = engine.load()['owners']
                if mode not in ('backward-clock', 'reboot'):
                    for p in policy.ports:
                        run('/usr/sbin/ipset', 'flush', f'cga{p}')
                check(not engine.load()['pending'], 'fixture did not start applied')
                pid = os.fork()
                if pid == 0:
                    class RepairKernel(Kernel):
                        def run(self, tool, *args, **kwargs):
                            if tool == 'ipset' and args[0] in ('create', 'flush', 'restore', 'swap', 'add', 'del'):
                                check(json.loads((STATE/'checkpoint.json').read_bytes())['pending'],
                                      'repair mutation preceded durable pending')
                            return super().run(tool, *args, **kwargs)
                        def swapped(self, swapped_port):
                            self.fence()
                            probe(8080, False)
                            if swapped_port == port:
                                if fault == 'SIGKILL':
                                    os.kill(os.getpid(), signal.SIGKILL)
                                if mode in ('backward-clock', 'reboot'):
                                    self.run('ipset', 'add', f'cga{port}', '8.8.8.2', 'timeout', '30')
                                else:
                                    self.run('ipset', 'del', f'cga{port}', '8.8.8.2')
                    options = {'boot': lambda: 'reboot-repair'} if mode == 'reboot' else {}
                    if mode == 'backward-clock':
                        options['clock'] = lambda: time.time()-100
                    broken = Engine(policy, STATE, RepairKernel(policy), **options)
                    try:
                        apply(broken, r) if mode == 'exact-replay' else read(broken)
                    except Rejected as exc:
                        # A clock refusal alone is NOT a readback-fault observation.
                        os._exit(77 if str(exc) == 'kernel_readback_failed' else 78)
                    except BaseException:
                        os._exit(79)
                    os._exit(80)
                _, status = os.waitpid(pid, 0)
                expected = -signal.SIGKILL if fault == 'SIGKILL' else 77
                check(os.waitstatus_to_exitcode(status) == expected, 'native repair fault never executed')
                state = engine.load()
                check(state['pending'] and state['owners'] == before, 'repair lost pending or changed owner sequence/expiry')
                Kernel(policy).fence()
                probe(8080, False)
                recovery = Engine(policy, STATE, Kernel(policy), boot=lambda: 'reboot-repair') if mode == 'reboot' else engine
                response = read(recovery)
                check(not engine.load()['pending'] and engine.load()['owners'] == before, 'repair did not complete readback')
                if mode == 'reboot':
                    check(response['verdict'] == 'fresh_snapshot_required', 'preboot state was admitted')
                    apply(recovery, r)
                    for p in policy.ports:
                        probe(p, False)
                    apply(recovery, request([entry(p, 90) for p in policy.ports], 2))
                for p in policy.ports:
                    probe(p, True)
                emit('native-repair-fault', mode=mode, port=port, fault=fault,
                     result='durable-pending-before-mutation;owner-state-preserved;read-repair')


def fsync_fault_cases(policy):
    """Fault real file/directory sync boundaries while using the actual Kernel."""
    from unittest.mock import patch
    for phase in ('new-apply', 'same-hash-repair', 'backward-clear', 'applied-mark'):
        for boundary in ('file', 'directory'):
            engine = reset(policy)
            r = request([entry(p, 90) for p in policy.ports])
            apply(engine, r)
            old = engine.load()
            if phase == 'same-hash-repair':
                for port in policy.ports:
                    run('/usr/sbin/ipset', 'flush', f'cga{port}')
            observed = {port: Kernel(policy).read(port) for port in policy.ports}
            real_fsync = os.fsync
            injected = [False]
            def fail_once(fd):
                directory = stat.S_ISDIR(os.fstat(fd).st_mode)
                current = json.loads((STATE/'checkpoint.json').read_bytes())
                # Applied-mark faults happen only after all native readbacks;
                # distinguish that save from the earlier pending barrier.
                final_mark = phase == 'applied-mark' and not engine_state[0]['pending']
                eligible = final_mark if phase == 'applied-mark' else True
                if eligible and not injected[0] and directory == (boundary == 'directory'):
                    injected[0] = True
                    raise OSError('injected native '+boundary+' fsync failure')
                return real_fsync(fd)
            engine_state = [None]
            class ObservedEngine(Engine):
                def save(self, state):
                    engine_state[0] = state
                    super().save(state)
            options = {'clock': lambda: time.time()-100} if phase == 'backward-clear' else {}
            faulty = ObservedEngine(policy, STATE, Kernel(policy), **options)
            if phase == 'applied-mark':
                for port in policy.ports:
                    run('/usr/sbin/ipset', 'flush', f'cga{port}')
            try:
                with patch('admission.os.fsync', side_effect=fail_once):
                    apply(faulty, request([entry(p, 95) for p in policy.ports], 2)) if phase == 'new-apply' else read(faulty)
            except OSError:
                pass
            else:
                raise AssertionError('native fsync fault returned applied')
            check(injected[0], 'native fsync boundary was not reached')
            state = engine.load()
            if phase != 'applied-mark':
                # No active set may change before a successful durable barrier.
                after = {port: Kernel(policy).read(port) for port in policy.ports}
                check(all(set(after[p]) == set(observed[p]) for p in policy.ports), 'fsync refusal mutated active sets')
                if boundary == 'file' and phase == 'new-apply':
                    check(state['owners'] == old['owners'], 'pre-rename fsync advanced sequence')
            if phase == 'applied-mark' or boundary == 'directory':
                check(state['pending'], 'fsync failure falsely retired pending')
            Kernel(policy).fence()
            probe(8080, False)
            read(engine)
            check(not engine.load()['pending'], 'fsync fault repair pending remained')
            for owner, value in state['owners'].items():
                check(engine.load()['owners'][owner] == value, 'fsync repair changed absolute expiry/sequence')
            emit('native-fsync-fault', phase=phase, boundary=boundary,
                 result='unavailable;no-premature-kernel-write;durable-state-repaired')


def compatible_manifest_rollback_case(policy):
    """Execute TWO independently pinned packages through one private active link.

    The reference artifact is new test machinery, not a claimed historical
    production release. Its eager pending algorithm differs from current code.
    Both versions use the real entrypoint, same durable state and actual Kernel.
    """
    reference = BASE/'fixtures/compatible-v1'
    pinned = json.loads((reference/'manifest.json').read_bytes())
    check(hashlib.sha256((reference/'admission.py').read_bytes()).hexdigest() == pinned['admissionSha256'],
          'compatible artifact differs from committed version pin')
    check(pinned['helperVersion'] == 'h1-compatible-v1-reference' and pinned['checkpointVersion'] == 1,
          'incompatible rollback artifact')
    (CONFIG/'policy.json').write_bytes(canonical(policy.value))
    (CONFIG/'policy.json').chmod(0o600)
    releases = ROOT/'releases'
    releases.mkdir(mode=0o700)
    manifests = {}
    for name in ('current', 'compatible-v1'):
        release = releases/name
        release.mkdir(mode=0o700)
        digests = {}
        for module in ('entrypoint.py', 'wrapper.py', 'admission.py', 'kernel.py'):
            origin = reference/module if name == 'compatible-v1' and module == 'admission.py' else BASE/module
            data = origin.read_bytes()
            (release/module).write_bytes(data)
            (release/module).chmod(0o600)
            digests[module] = hashlib.sha256(data).hexdigest()
            expected = pinned['admissionSha256'] if name == 'compatible-v1' and module == 'admission.py' else IDENTITY['fileDigests'][module]
            check(digests[module] == expected, 'release module pin mismatch')
        raw = canonical({'sourceSha': IDENTITY['sourceSha'], 'files': digests, 'helperVersion': name})
        (release/'source.json').write_bytes(raw)
        (release/'source.json').chmod(0o600)
        manifests[name] = hashlib.sha256(raw).hexdigest()
    check(manifests['current'] != manifests['compatible-v1'], 'rollback packages not distinct')
    active = releases/'active'
    def select_release(name):
        temporary = releases/'next'
        temporary.symlink_to(releases/name)
        os.replace(temporary, active)
    def invoke(body):
        child = subprocess.run(['/usr/bin/python3', '-I', str(active.resolve()/'entrypoint.py')],
                               input=canonical(body), stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=14)
        check(child.returncode == 0, 'selected helper failed: '+child.stdout.decode(errors='replace')[:512])
        value = json.loads(child.stdout)
        check(value['manifestDigest'] == manifests[active.resolve().name], 'wrong helper executed')
        return value
    reset(policy)
    r = request([entry(p, 90) for p in policy.ports])
    select_release('current')
    check(invoke(r)['sequence'] == 1, 'current helper initial commit')
    engine = Engine(policy, STATE, Kernel(policy))
    original = engine.load()['owners']
    select_release('compatible-v1')
    # Force REAL repair by the separately loaded reference implementation.
    for port in policy.ports:
        run('/usr/sbin/ipset', 'flush', f'cga{port}')
    check(invoke(r)['sequence'] == 1, 'compatible exact replay advanced sequence')
    for port in policy.ports:
        observed = Kernel(policy).read(port)
        check('8.8.8.2' in observed and observed['8.8.8.2'] <= r['entries'][0]['expiresAt']-time.time(),
              'compatible rollback extended absolute expiry')
        probe(port, True)
    Kernel(policy).fence()
    probe(8080, False)
    check(engine.load()['owners'] == original and not engine.load()['pending'], 'rollback changed sequence/expiry')
    select_release('current')
    check(invoke(r)['sequence'] == 1 and engine.load()['owners'] == original, 'forward restore changed owner state')
    emit('compatible-manifest-rollback', helperVersion=pinned['helperVersion'],
         referenceManifestDigest=hashlib.sha256((reference/'manifest.json').read_bytes()).hexdigest(),
         transitionedManifests=manifests, result='current-to-pinned-reference-to-current;actual-repair;sequence-and-expiry-preserved',
         limitation='New explicit compatible reference fixture; no historical production release or real-host cutover claimed')


def source_trust_cases(policy):
    """Root-owned sandbox counterexamples must refuse before ANY sibling effect."""
    package = ROOT/'trust-package'
    package.mkdir(mode=0o700)
    marker = ROOT/'UNTRUSTED_IMPORT_EXECUTED'
    evil = ROOT/'untrusted.py'
    evil.write_text('from pathlib import Path;Path('+repr(str(marker))+').touch()')
    for name in ('entrypoint.py', 'wrapper.py', 'admission.py', 'kernel.py'):
        (package/name).write_bytes((BASE/name).read_bytes())
        (package/name).chmod(0o600)
    raw = canonical({'sourceSha': IDENTITY['sourceSha'], 'files': {
        name: IDENTITY['fileDigests'][name] for name in ('entrypoint.py', 'wrapper.py', 'admission.py', 'kernel.py')}})
    (package/'source.json').write_bytes(raw)
    for fault in ('symlink', 'digest'):
        (package/'kernel.py').unlink()
        if fault == 'symlink':
            (package/'kernel.py').symlink_to(evil)
        else:
            (package/'kernel.py').write_bytes(evil.read_bytes())
        for name in ('wrapper.py', 'entrypoint.py'):
            child = subprocess.run(['/usr/bin/python3', '-I', str(package/name)], input=b'{}',
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=3)
            check(child.returncode != 0 and not marker.exists(), 'untrusted sibling executed before refusal')
    # An unmanifested sibling named like a stdlib module must never be imported.
    (package/'kernel.py').write_bytes((BASE/'kernel.py').read_bytes())
    (package/'ctypes.py').write_bytes(evil.read_bytes())
    body = canonical({'version':1, 'operation':'read', 'writerEpoch':'epoch-control'})
    child = subprocess.run(['/usr/bin/python3', '-I', str(package/'entrypoint.py')], input=body,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=14)
    check(child.returncode == 0 and not marker.exists(), 'sibling search path admitted unmanifested code')
    emit('source-trust', result='root-owned-fixture;symlink/digest-denied-before-effect;unmanifested-stdlib-shadow-never-imported')


def reboot_backward_expired_case(policy):
    engine = reset(policy)
    r = request([entry(5432, 6)])
    apply(engine, r)
    history = engine.load()['owners']
    saved_wall = engine.load()['wall']
    probe(5432, True)
    time.sleep(max(0, r['entries'][0]['expiresAt']-time.time()+.2))
    probe(5432, False)
    # Old absolute expiry looks FUTURE to this unsynced wall, which is still
    # ABOVE the saved wall. Different boot invalidates persisted grants anyway.
    rebooted = Engine(policy, STATE, Kernel(policy), boot=lambda:'unsynced-new-boot',
                      clock=lambda:saved_wall+1)
    response = read(rebooted)
    check(response['verdict'] == 'fresh_snapshot_required', 'combined reboot/clock counterexample admitted')
    apply(rebooted, r)
    probe(5432, False)
    check(engine.load()['owners'] == history and not engine.load()['pending'], 'expired replay changed history')
    synced = Engine(policy, STATE, Kernel(policy), boot=lambda:'unsynced-new-boot')
    read(synced)
    apply(synced, request([entry(5435, 12)], 2))
    probe(5435, True)
    probe(5432, False)
    emit('reboot-backward-expired-replay', result='no-preboot-revival;CAS-history-preserved;fresh-post-read-N+1-required')


def kernel_clock_jump_cases(policy):
    """Actual native TTLs across a wall jump after acceptance/build/readback.

    Only the adapter's wall reader is changed. The host clock, monotonic clock,
    native kernel expiry and NEW packet connections remain real.
    """
    import types
    from unittest.mock import patch
    for phase in ('after-checkpoint', 'during-construction', 'during-readback'):
        engine = reset(policy)
        body = request([entry(port, 6) for port in policy.ports])
        expires = min(value['expiresAt'] for value in body['entries'])
        jumped = [False]
        payloads = []
        def wall():
            return time.time()-100 if jumped[0] else time.time()
        class JumpKernel(Kernel):
            def run(self, tool, *args, payload=None):
                if phase == 'during-construction' and tool == 'ipset' and args[0] == 'flush':
                    jumped[0] = True
                if tool == 'ipset' and args[0] == 'restore':
                    for line in payload.decode().splitlines():
                        ttl = int(line.split()[-1])
                        check(ttl <= math.floor(expires-time.time()), 'wall jump extended native restore lifetime')
                        payloads.append(ttl)
                return super().run(tool, *args, payload=payload)
            def swapped(self, port):
                self.fence()
                if phase == 'during-readback':
                    jumped[0] = True
        class JumpEngine(Engine):
            def save(self, state):
                super().save(state)
                if state['pending'] and phase == 'after-checkpoint':
                    jumped[0] = True
        native = JumpKernel(policy)
        with patch('kernel.time', types.SimpleNamespace(time=wall, monotonic=time.monotonic)):
            try:
                apply(JumpEngine(policy, STATE, native), body)
            except Rejected as exc:
                check(str(exc) == 'clock_rollback_during_apply', 'wrong clock refusal')
            else:
                raise AssertionError('mid-operation wall rollback returned applied')
        check(jumped[0], 'wall-jump falsifier never entered its target stage')
        check(engine.load()['pending'], 'clock failure falsely retired pending')
        check(bool(payloads) == (phase == 'during-readback'), 'unexpected native writes before clock refusal')
        Kernel(policy).fence()
        for port in policy.ports:
            observed = Kernel(policy).read(port)
            check(all(ttl <= math.ceil(expires-time.time()) for ttl in observed.values()),
                  'kernel readback exceeds acceptance-time expiry budget')
            if phase != 'during-readback':
                probe(port, False)
        if phase == 'during-readback':
            probe(policy.ports[0], True)
        # No invocation repairs or refreshes anything while time actually passes.
        time.sleep(max(0, expires-time.time()+.2))
        for port in policy.ports:
            probe(port, False)
        emit('native-kernel-clock-jump', phase=phase, restoreTtls=payloads,
             result='rollback-refused;pending-preserved;monotonic-bound;actual-readback;no-invocation-expiry')


def ssh_cases(policy):
    reset(policy)
    (CONFIG/'policy.json').write_bytes(canonical(policy.value))
    (CONFIG/'policy.json').chmod(0o600)
    for name in ('host-key', 'client-key'):
        run('/usr/bin/ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-f', str(ROOT/name))
    forced = '/usr/bin/python3 -I '+str(BASE/'wrapper.py')
    public = (ROOT/'client-key.pub').read_text().strip()
    (ROOT/'authorized_keys').write_text('restrict,command="'+forced+'" '+public+'\n')
    (ROOT/'authorized_keys').chmod(0o600)
    host_public = (ROOT/'host-key.pub').read_text().split()
    (ROOT/'known_hosts').write_text('[127.0.0.1]:22222 '+host_public[0]+' '+host_public[1]+'\n')
    config = f'''Port 22222
ListenAddress 127.0.0.1
HostKey {ROOT}/host-key
PidFile {ROOT}/sshd.pid
AuthorizedKeysFile {ROOT}/authorized_keys
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
UsePAM no
StrictModes yes
AllowUsers root
DisableForwarding yes
AllowTcpForwarding no
AllowStreamLocalForwarding no
AllowAgentForwarding no
X11Forwarding no
PermitTunnel no
PermitTTY no
PermitUserRC no
PermitUserEnvironment no
MaxSessions 1
MaxStartups 3:30:5
LoginGraceTime 5
ForceCommand {forced}
Subsystem sftp internal-sftp
LogLevel VERBOSE
'''
    (ROOT/'sshd_config').write_text(config)
    run('/usr/sbin/sshd', '-t', '-f', str(ROOT/'sshd_config'))
    effective = run('/usr/sbin/sshd', '-T', '-f', str(ROOT/'sshd_config'), '-C', 'user=root,host=localhost,addr=127.0.0.1')
    for setting in ['disableforwarding yes', 'permittty no', 'permituserrc no',
                    'permituserenvironment no', 'allowagentforwarding no',
                    'allowtcpforwarding no', 'allowstreamlocalforwarding no',
                    'maxsessions 1', 'maxstartups 3:30:5', 'logingracetime 5']:
        check(setting in effective, 'effective sshd boundary '+setting)
    check(not any(line.startswith('acceptenv ') for line in effective.splitlines()), 'sshd accepts caller env')
    log = open(ROOT/'sshd.log', 'wb')
    server = subprocess.Popen(['/usr/sbin/sshd', '-D', '-e', '-f', str(ROOT/'sshd_config')], stdout=log, stderr=log)
    PROCESSES.append(server)
    time.sleep(.15)
    check(server.poll() is None, 'sandbox sshd failed to start')
    ssh = ['/usr/bin/ssh', '-F', '/dev/null', '-p', '22222', '-i', str(ROOT/'client-key'),
           '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
           '-o', 'UserKnownHostsFile='+str(ROOT/'known_hosts'), '-o', 'GlobalKnownHostsFile=/dev/null',
           '-o', 'ConnectTimeout=2', '-o', 'LogLevel=ERROR']
    def call(body, extra=(), remote=(), seconds=5):
        return subprocess.run([*ssh, *extra, 'root@127.0.0.1', *remote], input=body,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=seconds,
                              env={'PATH': '/usr/bin:/bin', 'SSH_AUTH_SOCK': str(ROOT/'agent.sock')})
    body = canonical(request([entry(5432)]))
    accepted = call(body, ['-T'])
    check(accepted.returncode == 0, 'real SSH apply failed: '+accepted.stderr.decode()[:1024]+accepted.stdout.decode()[:1024])
    check(json.loads(accepted.stdout)['sequence'] == 1, 'SSH did not apply fixed primitive')
    probe(5432, True)
    read_body = canonical({'version': 1, 'operation': 'read', 'writerEpoch': 'epoch-control'})
    for label, extra, remote in [
            ('shell-command', [], ['touch /run/h1/COMMAND_EXECUTED']),
            ('sftp', ['-s'], ['sftp']),
            ('scp', [], ['scp -t /run/h1/scp']),
            ('direct-forward', ['-W', '127.0.0.1:22222'], []),
            ('remote-forward', ['-o', 'ExitOnForwardFailure=yes', '-R', '22223:127.0.0.1:22222'], [])]:
        response = call(read_body, extra, remote)
        check(response.returncode != 0, label+' accepted')
        emit('ssh-negative', case=label, exit=response.returncode)
    pty = call(read_body, ['-tt'])
    check(b'PTY allocation request failed' in pty.stderr, 'PTY request was not denied')
    agent = subprocess.Popen(['/usr/bin/ssh-agent', '-D', '-a', str(ROOT/'agent.sock')],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    PROCESSES.append(agent)
    time.sleep(.1)
    added = subprocess.run(['/usr/bin/ssh-add', str(ROOT/'client-key')],
                           env={'SSH_AUTH_SOCK': str(ROOT/'agent.sock')},
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=2)
    check(added.returncode == 0, 'sandbox-only agent key load')
    (ROOT/'scp-source').write_text('sandbox-only\n')
    scp = subprocess.run(['/usr/bin/scp', '-O', '-F', '/dev/null', '-P', '22222',
                          '-i', str(ROOT/'client-key'), '-o', 'BatchMode=yes',
                          '-o', 'StrictHostKeyChecking=yes', '-o', 'UserKnownHostsFile='+str(ROOT/'known_hosts'),
                          str(ROOT/'scp-source'), 'root@127.0.0.1:/run/h1/SCP_EXECUTED'],
                         stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=5)
    check(scp.returncode != 0 and not (ROOT/'SCP_EXECUTED').exists(), 'actual SCP client was accepted')
    injected = call(read_body, ['-o', 'SetEnv=PYTHONPATH=/run/h1 LD_PRELOAD=/run/h1/evil', '-A'])
    check(injected.returncode == 0, 'rejected env should be ignored by sshd, not injected')
    check(not (ROOT/'RC_EXECUTED').exists() and not (ROOT/'COMMAND_EXECUTED').exists(), 'rc/command executed')
    # EOF, JSON, byte bound and slow-input refusal through the ACTUAL SSH path.
    for payload in (b'{', b'x'*32769, canonical({**json.loads(read_body), 'path': '/tmp/evil'})):
        check(call(payload).returncode != 0, 'invalid/oversize/path input accepted')
    slow = subprocess.Popen([*ssh, '-T', 'root@127.0.0.1'], stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    start = time.monotonic()
    slow.wait(timeout=4)
    check(slow.returncode != 0 and time.monotonic()-start < 4, '2s EOF input budget')
    slow.stdin.close();slow.stdout.close();slow.stderr.close()
    # Busy lock is rejected before waiting for stdin. SSH/auth still costs processes.
    with locked(STATE):
        busy = subprocess.Popen([*ssh, '-T', 'root@127.0.0.1'], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        start = time.monotonic()
        busy.wait(timeout=2)
        check(busy.returncode != 0 and time.monotonic()-start < 2, 'busy lock waited on stdin')
        busy.stdin.close();busy.stdout.close();busy.stderr.close()
        contenders = [subprocess.Popen([*ssh, '-T', 'root@127.0.0.1'], stdin=subprocess.DEVNULL,
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) for _ in range(8)]
        try:
            # Count actual namespace processes; no claim of a global connection cap.
            snapshot = run('/usr/bin/ps', '-eo', 'pid,ppid,comm')
            counts = {name: sum(name in line for line in snapshot.splitlines()) for name in ('sshd', 'ssh', 'python3')}
            for contender in contenders:
                check(contender.wait(timeout=6) != 0, 'losing contender acquired expensive lock')
        finally:
            for contender in contenders:
                terminate(contender)
        emit('ssh-cost-bound', processes=counts, effectiveLimits='MaxSessions=1 MaxStartups=3:30:5 LoginGraceTime=5',
             limitation='nonblocking lock bounds expensive work only; SSH/auth processes still consume resources')
    # A client disconnect cannot revert an acknowledged durable sequence.
    check(Engine(policy, STATE, Kernel(policy)).load()['owners']['control']['sequence'] == 1, 'SSH denial reverted commit')
    disconnect = subprocess.Popen([*ssh, '-T', 'root@127.0.0.1'], stdin=subprocess.PIPE,
                                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    disconnect.stdin.write(canonical(request([entry(5435)], 2)))
    disconnect.stdin.close()
    deadline = time.monotonic()+4
    while Engine(policy, STATE, Kernel(policy)).load()['owners']['control']['sequence'] != 2:
        check(time.monotonic() < deadline, 'disconnect fixture never committed new sequence')
        time.sleep(.01)
    if disconnect.poll() is None:
        disconnect.kill()
    disconnect.wait(timeout=2)
    time.sleep(.2)
    response = call(read_body)
    check(response.returncode == 0 and json.loads(response.stdout)['sequence'] == 2,
          'disconnect reverted a committed sequence or retained lock')
    probe(5435, True)
    log.close()
    emit('ssh-boundary', result='pinned-hostkey;forced-command;forwarding;PTY;SFTP;SCP;env;rc;input;lock;disconnect',
         effectiveConfig=effective)


def process_cases(policy):
    # Hung child and output flood are actual OS processes, never subprocess mocks.
    for args, reason in [(['/usr/bin/python3', '-c', 'import time;time.sleep(30)'], 'child_timeout'),
                         (['/usr/bin/python3', '-c', 'import os;os.write(1,b"x"*100000)'], 'child_output_overflow')]:
        start = time.monotonic()
        try:
            command(args, seconds=.2, cap=1024)
        except Rejected as exc:
            check(str(exc) == reason, 'wrong process refusal')
        else:
            raise AssertionError('child bound failed')
        check(time.monotonic()-start < 1, 'child cleanup exceeded one second')
    # Actual privileged worker cancellation; parent-death signal must release lock.
    wrapper = ['/usr/bin/python3', '-I', str(BASE/'wrapper.py')]
    for sig in (signal.SIGTERM, signal.SIGKILL):
        child = subprocess.Popen(wrapper, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        PROCESSES.append(child)
        time.sleep(.15)
        child.send_signal(sig)
        child.wait(timeout=3)
        time.sleep(.15)
        with locked(STATE):
            pass
        child.stdin.close();child.stdout.close();child.stderr.close()
    # 12s operation timer and 20+2 watchdog use actual blocking processes. The
    # test-only copy binds a deliberately hung Engine; installed source is untouched.
    private = ROOT/'watchdog'
    private.mkdir(mode=0o700)
    (private/'wrapper.py').write_bytes((BASE/'wrapper.py').read_bytes())
    (private/'kernel.py').write_bytes((BASE/'kernel.py').read_bytes())
    (private/'admission.py').write_bytes((BASE/'admission.py').read_bytes())
    (private/'entrypoint.py').write_text('import time\ntime.sleep(60)\n')
    digest_map = {name: hashlib.sha256((private/name).read_bytes()).hexdigest()
                  for name in ('wrapper.py', 'entrypoint.py', 'admission.py', 'kernel.py')}
    (private/'source.json').write_bytes(canonical({'sourceSha': IDENTITY['sourceSha'], 'files': digest_map}))

    start = time.monotonic()
    child = subprocess.Popen(['/usr/bin/python3', '-I', str(private/'wrapper.py')], stdin=subprocess.DEVNULL)
    PROCESSES.append(child)
    check(child.wait(timeout=23) != 0 and 19 <= time.monotonic()-start <= 23, '20s watchdog/2s cleanup')
    # Exercise real entrypoint's 12s signal handler without adding production hooks.
    import importlib.util
    spec = importlib.util.spec_from_file_location('fixed_entrypoint', BASE/'entrypoint.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.signal.alarm(0)
    pid = os.fork()
    if pid == 0:
        class Hung:
            def __init__(self, *args):
                pass
            def execute(self, *args):
                (ROOT/'deadline-execute-entered').write_text('entered')
                time.sleep(60)
        sys.argv = [str(BASE/'entrypoint.py')]
        module.perform = Hung().execute
        r,w=os.pipe();os.write(w,canonical({'version':1,'operation':'read','writerEpoch':'epoch-control'}));os.close(w)
        os.dup2(r,0);os.close(r)
        try:
            module.main()
        except module.Rejected as exc:
            os._exit(77 if str(exc) == 'operation_interrupted' else 78)
        os._exit(79)
    start = time.monotonic()
    _,status = os.waitpid(pid,0)
    check((ROOT/'deadline-execute-entered').read_text() == 'entered', 'deadline test bypassed execute')
    check(os.waitstatus_to_exitcode(status) == 77 and 11 <= time.monotonic()-start < 14, '12s operation deadline')
    emit('process-bounds', result='1s-child;output-cap;SIGTERM;SIGKILL;12s-operation;20s-watchdog-plus-2s-grace')


def worker():
    global IDENTITY
    check(len(sys.argv) == 5 and sys.argv[1] == '--worker', 'fixed isolated invocation')
    IDENTITY = json.loads(sys.argv[4])
    private_filesystem(sys.argv[2], sys.argv[3])
    policy = Policy({'version': 1, 'destination': '192.0.2.1', 'interface': 'wan', 'ports': PORTS,
                     'owners': {owner: {'writerEpoch': 'epoch-'+owner, 'ports': PORTS} for owner in ('control', 'other')}})
    try:
        setup_network(policy)
        fence_order_case(policy)
        kernel_cases(policy)
        repair_fault_cases(policy)
        fsync_fault_cases(policy)
        compatible_manifest_rollback_case(policy)
        source_trust_cases(policy)
        reboot_backward_expired_case(policy)
        kernel_clock_jump_cases(policy)
        ssh_cases(policy)
        process_cases(policy)
    finally:
        for child in reversed(PROCESSES):
            terminate(child)
        # Netns names and mounts are private and die with PID1; no host iptables
        # cleanup or global namespace deletion is ever attempted.
    emit('worker-complete', 'complete', result='all-actual-assertions-complete')


if __name__ == '__main__':
    syslog.openlog('cogni-host-admission', syslog.LOG_PID, syslog.LOG_AUTHPRIV)
    try:
        load_verified_bundle()
        if '--worker' in sys.argv:
            worker()
        else:
            check(len(sys.argv) == 1, 'no caller selftest options')
            outer()
    except BaseException as exc:
        emit('suite-failed', 'failure', detail=type(exc).__name__+':'+str(exc)[:1024])
        sys.exit(1)
