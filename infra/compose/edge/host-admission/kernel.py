# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Fixed Linux ipset adapter. Never installs, removes or flushes packet rules.

Provisioning must establish the fixed fence first. Every reconcile verifies it
before and after EACH swap. Five ports maximum; bounded native child invocations.
Test-side subclasses may interrupt swaps; production exposes no failpoint input.
"""
import ctypes
import math
import os
from pathlib import Path
import select
import signal
import subprocess
import time
from admission import CAPACITY, Rejected

TOOLS = {'ipset': '/usr/sbin/ipset', 'iptables': '/usr/sbin/iptables'}


def die_with_parent(parent=None):
    # Linux child dies even if the worker is SIGKILLed between Popen and wait.
    parent = os.getppid() if parent is None else parent
    if ctypes.CDLL(None).prctl(1, signal.SIGKILL, 0, 0, 0) != 0 or os.getppid() != parent:
        os._exit(127)


def command(argv, payload=None, seconds=1, cap=65536):
    """No shell or caller env; cap output while reading (not after allocation)."""
    child = subprocess.Popen(argv, stdin=subprocess.PIPE if payload is not None else subprocess.DEVNULL,
                             stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C'},
                             preexec_fn=lambda parent=os.getpid(): die_with_parent(parent))
    deadline = time.monotonic() + seconds
    output = bytearray()
    try:
        if payload is not None:
            # restore input is at most 128 lines, below the Linux pipe capacity.
            os.set_blocking(child.stdin.fileno(), False)
            position = 0
            while position < len(payload):
                remaining = deadline - time.monotonic()
                if remaining <= 0 or not select.select([], [child.stdin], [], remaining)[1]:
                    raise Rejected('child_timeout')
                position += os.write(child.stdin.fileno(), payload[position:])
            child.stdin.close()
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0 or not select.select([child.stdout], [], [], remaining)[0]:
                raise Rejected('child_timeout')
            chunk = os.read(child.stdout.fileno(), min(4096, cap+1-len(output)))
            if not chunk:
                break
            output.extend(chunk)
            if len(output) > cap:
                raise Rejected('child_output_overflow')
        if child.wait(timeout=max(.001, deadline-time.monotonic())) != 0:
            raise Rejected('child_failed:' + Path(argv[0]).name + ':' + output.decode(errors='replace')[:512])
        return output.decode('utf-8')
    except subprocess.TimeoutExpired as exc:
        raise Rejected('child_timeout') from exc
    finally:
        if child.poll() is None:
            child.kill()
        child.wait()
        child.stdout.close()
        if child.stdin and not child.stdin.closed:
            child.stdin.close()


def fence_rules(policy):
    result = []
    for port in policy.ports:
        match = ['-i', policy.interface, '-p', 'tcp', '-m', 'conntrack', '--ctdir', 'ORIGINAL',
                 '--ctorigdst', policy.destination, '--ctorigdstport', str(port)]
        result += [match + ['-m', 'set', '--match-set', f'cga{port}', 'src', '-j', 'ACCEPT'],
                   match + ['-j', 'DROP']]
    return result


class Kernel:
    def __init__(self, policy):
        self.policy = policy

    def run(self, tool, *args, payload=None):
        return command([TOOLS[tool], *args], payload=payload)

    def fence(self):
        # Never create a fence on ordinary invocation. Missing/wrong rules refuse.
        docker = self.run('iptables', '-w', '0', '-S', 'DOCKER-USER').splitlines()
        rules = [line for line in docker if line.startswith('-A ')]
        if not rules or rules[0] != '-A DOCKER-USER -j CGADMIT':
            raise Rejected('fence_not_first')
        forward = self.run('iptables', '-w', '0', '-S', 'FORWARD').splitlines()
        if next((line for line in forward if line.startswith('-A ')), '') != '-A FORWARD -j DOCKER-USER':
            raise Rejected('docker_user_not_first')
        text = self.run('iptables', '-w', '0', '-S', 'CGADMIT')
        lines = [line for line in text.splitlines() if line.startswith('-A ')]
        expected = fence_rules(self.policy)
        if len(lines) != len(expected):
            raise Rejected('fence_shape')
        for args in expected:
            self.run('iptables', '-w', '0', '-C', 'CGADMIT', *args)

    def read(self, port):
        text = self.run('ipset', 'save', f'cga{port}')
        result = {}
        for line in text.splitlines():
            fields = line.split()
            if fields[:1] == ['create']:
                if fields[2] != 'hash:ip' or 'timeout' not in fields or 'maxelem' not in fields or fields[fields.index('maxelem')+1] != str(CAPACITY) or 'family' not in fields or fields[fields.index('family')+1] != 'inet' or fields[fields.index('timeout')+1] != '600':
                    raise Rejected('set_incompatible')
            elif fields[:1] == ['add']:
                if len(fields) != 5 or fields[3] != 'timeout':
                    raise Rejected('set_readback_shape')
                ttl = int(fields[4])
                if not 0 < ttl <= 600:
                    raise Rejected('permanent_or_invalid_timeout')
                result[fields[2]] = ttl
        return result

    def matches(self, entries, observed, now):
        # Allow early removal only during the conservative rounding/command margin.
        required = {ip for ip, expiry in entries.items() if expiry-now > 4}
        permitted = {ip for ip, expiry in entries.items() if expiry-now > 0}
        return required <= set(observed) <= permitted and all(
            0 < ttl <= math.ceil(entries[ip]-now) and ttl >= max(1, math.floor(entries[ip]-now)-4)
            for ip, ttl in observed.items())

    def swapped(self, port):
        """Test subclass seam only; never selected by the production entrypoint."""

    def reconcile(self, union):
        self.fence()
        for port in self.policy.ports:
            entries = union[port]
            if self.matches(entries, self.read(port), time.time()):
                continue
            # A fixed compatible scratch set per port; lock serializes its use.
            scratch = f'cgat{port}'
            self.run('ipset', 'create', scratch, 'hash:ip', 'family', 'inet',
                     'timeout', '600', 'maxelem', str(CAPACITY), '-exist')
            self.run('ipset', 'flush', scratch)
            now = time.time()
            lines = []
            for ip, expiry in sorted(entries.items()):
                ttl = math.floor(expiry-now)-2
                if ttl > 0:
                    lines.append(f'add {scratch} {ip} timeout {ttl}')
            if lines:
                self.run('ipset', 'restore', payload=('\n'.join(lines)+'\n').encode())
            self.run('ipset', 'swap', scratch, f'cga{port}')
            self.fence()
            self.swapped(port)
        for port in self.policy.ports:
            if not self.matches(union[port], self.read(port), time.time()):
                raise Rejected('kernel_readback_failed')
        self.fence()
