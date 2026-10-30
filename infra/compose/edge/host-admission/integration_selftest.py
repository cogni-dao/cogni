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
import socket
import subprocess
import sys
import syslog
import time
import uuid

BASE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(BASE))
from admission import Engine, Policy, Rejected, canonical, digest, locked, parse
from kernel import Kernel, command, fence_rules, die_with_parent
from source_manifest import FILES

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
    raw = (BASE / 'source.json').read_bytes()
    manifest = json.loads(raw)
    check(set(manifest) == {'sourceSha', 'files'}, 'manifest shape')
    check(re.fullmatch('[0-9a-f]{40}', manifest['sourceSha']), 'source SHA')
    check(set(manifest['files']) == set(FILES), 'complete source closure')
    for name in FILES:
        check(hashlib.sha256((BASE/name).read_bytes()).hexdigest() == manifest['files'][name], 'source digest '+name)
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


def host_snapshot():
    # Native rule shape (not counters). Legacy files only; never read private keys.
    files = ['/etc/iptables/rules.v4', '/etc/iptables/rules.v6',
             '/etc/cogni/compute-egress-allowlist', '/etc/cogni-compute-egress.allowlist',
             '/usr/local/sbin/cogni-harden-docker-public-ports.sh', '/etc/systemd/system/cogni-harden-docker-public-ports.service', '/opt/cogni-template-runtime/compute-egress-allowlist']
    return {'net': namespace('net'), 'mnt': namespace('mnt'),
            'rules4': run('/usr/sbin/iptables-save'), 'rules6': run('/usr/sbin/ip6tables-save'),
            'files': {name: hashlib.sha256(Path(name).read_bytes()).hexdigest()
                      if Path(name).is_file() else None for name in files}}


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
    total = bytearray()
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
            if len(total) > 262144:
                raise RuntimeError('bounded selftest output exceeded')
        result = child.wait(timeout=2)
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
        after = host_snapshot()
        check(before == after, 'legacy host rules/files or namespace changed')
        emit('legacy-host-unchanged', hostNet=before['net'], hostMount=before['mnt'])
    diagnostics = False
    for line in total.decode(errors='replace').splitlines():
        try:
            row = json.loads(line)
            check(row.get('sourceSha') == IDENTITY['sourceSha'] and row.get('runId') == IDENTITY['runId'], 'worker source binding')
            syslog.syslog(syslog.LOG_INFO, json.dumps(row))
            print(json.dumps(row), flush=True)
        except (ValueError, AttributeError):
            diagnostics = True
            emit('worker-diagnostic', 'failure', detail=line[:1024])
    check(result == 0 and not diagnostics, 'isolated kernel/SSH proof failed; exit='+str(result))
    check(any('"operation": "suite"' in line and '"verdict": "pass"' in line
              for line in total.decode().splitlines()), 'missing actual assertion completion')
    emit('selftest', result='actual-kernel-ssh-complete')


def private_filesystem(host_net, host_mount):
    # THIS assertion precedes ANY kernel mutation, including fixture creation.
    check(namespace('net') != host_net and namespace('mnt') != host_mount, 'unsafe initial host namespace')
    check(Path('/proc/1/ns/net').readlink() == Path('/proc/self/ns/net').readlink(), 'private PID/proc binding')
    run('/usr/bin/mount', '--make-rprivate', '/')
    for path in ('/run', '/etc', '/var/lib', '/var/log', '/root', '/tmp'):
        run('/usr/bin/mount', '-t', 'tmpfs', '-o', 'mode=755', 'h1-private', path)
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

    # Reboot style empty kernel + compatible older Engine code, same durable format.
    engine = reset(policy)
    r = request([entry(5432, 12)])
    apply(engine, r)
    for p in policy.ports:
        run('/usr/sbin/ipset', 'flush', f'cga{p}')
    rebooted = Engine(policy, STATE, Kernel(policy), boot=lambda: 'simulated-new-boot')
    read(rebooted)
    check(rebooted.load()['owners']['control']['sequence'] == 1, 'reboot/rollback decreased sequence')
    check(Kernel(policy).read(5432)['8.8.8.2'] <= r['entries'][0]['expiresAt']-time.time(), 'reboot extended lifetime')
    # Inject only test-side clocks; kernel remains REAL. No host clock mutation.
    back = Engine(policy, STATE, Kernel(policy), clock=lambda: time.time()-100)
    rejected(lambda: read(back))
    probe(5432, False)
    forward = Engine(policy, STATE, Kernel(policy), clock=lambda: time.time()+700)
    read(forward)
    probe(5432, False)
    emit('reboot-compatible-rollback-clock', result='absolute-expiry-preserved;backward-fails-closed;forward-expires')


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
                time.sleep(60)
        module.Engine = Hung
        r,w=os.pipe();os.write(w,canonical({'version':1,'operation':'read','writerEpoch':'epoch-control'}));os.close(w)
        os.dup2(r,0);os.close(r)
        try:
            module.main()
        except Rejected as exc:
            os._exit(77 if str(exc) == 'operation_interrupted' else 78)
        os._exit(79)
    start = time.monotonic()
    _,status = os.waitpid(pid,0)
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
        kernel_cases(policy)
        ssh_cases(policy)
        process_cases(policy)
    finally:
        for child in reversed(PROCESSES):
            terminate(child)
        # Netns names and mounts are private and die with PID1; no host iptables
        # cleanup or global namespace deletion is ever attempted.
    emit('suite', result='all-actual-assertions-complete')


if __name__ == '__main__':
    syslog.openlog('cogni-host-admission', syslog.LOG_PID, syslog.LOG_AUTHPRIV)
    try:
        if '--worker' in sys.argv:
            worker()
        else:
            check(len(sys.argv) == 1, 'no caller selftest options')
            outer()
    except BaseException as exc:
        emit('selftest', 'failure', detail=type(exc).__name__+':'+str(exc)[:1024])
        sys.exit(1)
