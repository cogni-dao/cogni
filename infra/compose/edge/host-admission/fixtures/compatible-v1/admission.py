# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
"""Frozen compatible-v1 reference helper fixture (never a claimed past release).

Its conservative eager pending barrier is an independent compatible algorithm.
Bounded v1 full-owner snapshots. No network, shell, or installation authority.

R7 B3/task.5389: durable pending precedes kernel swaps; read and exact replay repair.
Trusted callers must read sequence BEFORE enumerating a fresh complete snapshot.
Only trusted provisioning can bind Policy/owner; request bytes cannot select them.
"""
import contextlib
import fcntl
import hashlib
import ipaddress
import json
import math
import os
from pathlib import Path
import re
import select
import tempfile
import time

CAPACITY = 128
MAX_BYTES = 32768


class Rejected(Exception):
    """A bounded refusal; never an applied receipt."""


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()


def digest(entries):
    return hashlib.sha256(canonical(entries)).hexdigest()


def unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise Rejected('duplicate_field')
        result[key] = value
    return result


def decode(raw):
    if len(raw) > MAX_BYTES:
        raise Rejected('input_overflow')
    try:
        return json.loads(raw, object_pairs_hook=unique,
                          parse_constant=lambda _: (_ for _ in ()).throw(Rejected('nonfinite')))
    except (ValueError, UnicodeError, RecursionError) as exc:
        raise Rejected('invalid_json') from exc


def fields(obj, keys):
    if type(obj) is not dict or set(obj) != set(keys):
        raise Rejected('fields')


def integer(value, minimum=0, maximum=2**53-1):
    if type(value) is not int or not minimum <= value <= maximum:
        raise Rejected('integer')
    return value


class Policy:
    """Root-owned fixed destination, ingress interface, published ports and epochs."""
    def __init__(self, value):
        fields(value, ('version', 'destination', 'interface', 'ports', 'owners'))
        if type(value['version']) is not int or value['version'] != 1:
            raise Rejected('policy_version')
        try:
            if str(ipaddress.IPv4Address(value['destination'])) != value['destination']:
                raise ValueError()
        except (ValueError, TypeError) as exc:
            raise Rejected('policy_destination') from exc
        if not re.fullmatch(r'[a-zA-Z0-9_.-]{1,15}', value['interface']):
            raise Rejected('policy_interface')
        ports = value['ports']
        if type(ports) is not list or not 1 <= len(ports) <= 5 or len(set(ports)) != len(ports):
            raise Rejected('policy_ports')
        for port in ports:
            integer(port, 1, 65535)
            if port == 8080:
                raise Rejected('forbidden_port')
        owners = value['owners']
        if type(owners) is not dict or not 1 <= len(owners) <= 16:
            raise Rejected('policy_owners')
        for owner, config in owners.items():
            if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', owner):
                raise Rejected('policy_owner')
            fields(config, ('writerEpoch', 'ports'))
            if not isinstance(config['writerEpoch'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', config['writerEpoch']):
                raise Rejected('policy_epoch')
            if type(config['ports']) is not list or not config['ports'] or not set(config['ports']) <= set(ports):
                raise Rejected('owner_ports')
        self.value = value
        self.ports = tuple(sorted(ports))
        self.owners = owners
        self.destination = value['destination']
        self.interface = value['interface']


def parse(raw, policy, owner, now):
    obj = decode(raw)
    if type(obj) is not dict or owner not in policy.owners:
        raise Rejected('owner')
    operation = obj.get('operation')
    keys = ['version', 'operation', 'writerEpoch']
    if operation == 'apply':
        keys += ['expectedSequence', 'nextSequence', 'snapshotHash', 'entries']
    elif operation != 'read':
        raise Rejected('operation')
    fields(obj, keys)
    if type(obj['version']) is not int or obj['version'] != 1:
        raise Rejected('version')
    if obj['writerEpoch'] != policy.owners[owner]['writerEpoch']:
        raise Rejected('writer_epoch')
    if operation == 'read':
        return obj
    integer(obj['expectedSequence'])
    integer(obj['nextSequence'], 1)
    if obj['nextSequence'] != obj['expectedSequence'] + 1:
        raise Rejected('sequence_step')
    entries = obj['entries']
    if type(entries) is not list or len(entries) > CAPACITY:
        raise Rejected('owner_overflow')
    seen = set()
    for entry in entries:
        fields(entry, ('ipv4', 'publishedPort', 'expiresAt'))
        try:
            ip = ipaddress.IPv4Address(entry['ipv4'])
            if not ip.is_global or ip.is_multicast or str(ip) != entry['ipv4']:
                raise ValueError()
        except (ValueError, TypeError) as exc:
            raise Rejected('public_ipv4_required') from exc
        integer(entry['publishedPort'], 1, 65535)
        if entry['publishedPort'] not in policy.owners[owner]['ports']:
            raise Rejected('published_port')
        # Absolute seconds only. Expired exact replays are safe but cannot grant.
        integer(entry['expiresAt'], 1)
        if entry['expiresAt'] > math.floor(now) + 600:
            raise Rejected('expiry_horizon')
        key = (entry['ipv4'], entry['publishedPort'])
        if key in seen:
            raise Rejected('duplicate_entry')
        seen.add(key)
    if obj['snapshotHash'] != digest(entries):
        raise Rejected('snapshot_hash')
    return obj


@contextlib.contextmanager
def locked(root):
    """Acquire before reading stdin. No host wait queue for expensive operations."""
    fd = os.open(Path(root) / 'lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise Rejected('busy') from exc
        yield
    finally:
        os.close(fd)


def receive(fd, seconds=2):
    deadline = time.monotonic() + seconds
    data = bytearray()
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([fd], [], [], remaining)[0]:
            raise Rejected('input_timeout')
        chunk = os.read(fd, min(4096, MAX_BYTES + 1 - len(data)))
        if not chunk:
            return bytes(data)
        data.extend(chunk)
        if len(data) > MAX_BYTES:
            raise Rejected('input_overflow')


class Engine:
    def __init__(self, policy, root, kernel, clock=time.time,
                 boot=lambda: Path('/proc/sys/kernel/random/boot_id').read_text().strip(),
                 monotonic=time.monotonic):
        self.policy, self.root, self.kernel = policy, Path(root), kernel
        self.clock, self.boot, self.monotonic = clock, boot, monotonic

    def load(self):
        path = self.root / 'checkpoint.json'
        if not path.exists():
            return {'version': 1, 'destination': self.policy.destination, 'owners': {},
                    'ownerBoots': {}, 'pending': False, 'desiredHash': None, 'appliedHash': None, 'wall': 0, 'boot': self.boot(), 'mono': 0}
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            raw = os.read(fd, 1024*1024 + 1)
        finally:
            os.close(fd)
        if len(raw) > 1024*1024:
            raise Rejected('checkpoint_overflow')
        try:
            state = json.loads(raw, object_pairs_hook=unique)
            if 'ownerBoots' not in state:
                state['ownerBoots'] = {owner: state['boot'] for owner in state['owners']}
            if type(state['ownerBoots']) is not dict or set(state['ownerBoots']) != set(state['owners']) or any(
                    not isinstance(value, str) or len(value) > 128 for value in state['ownerBoots'].values()):
                raise Rejected('checkpoint_owner_boots')
            fields(state, ('ownerBoots', 'version', 'destination', 'owners', 'pending', 'desiredHash', 'appliedHash', 'wall', 'boot', 'mono'))
            if type(state['pending']) is not bool or not isinstance(state['boot'], str) or len(state['boot']) > 128:
                raise Rejected('checkpoint_metadata')
            for key in ('wall', 'mono'):
                if type(state[key]) not in (int, float) or not math.isfinite(state[key]) or state[key] < 0:
                    raise Rejected('checkpoint_clock')
            for key in ('desiredHash', 'appliedHash'):
                if state[key] is not None and (not isinstance(state[key], str) or not re.fullmatch('[0-9a-f]{64}', state[key])):
                    raise Rejected('checkpoint_hash')
            if state['version'] != 1 or state['destination'] != self.policy.destination:
                raise Rejected('checkpoint_incompatible')
            if not set(state['owners']) <= set(self.policy.owners):
                raise Rejected('checkpoint_owner')
            for owner, stored in state['owners'].items():
                fields(stored, ('sequence', 'hash', 'epoch', 'entries', 'validUntil'))
                integer(stored['sequence'], 1)
                if not isinstance(stored['epoch'], str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', stored['epoch']):
                    raise Rejected('checkpoint_epoch')
                request = {'version': 1, 'operation': 'apply', 'writerEpoch': self.policy.owners[owner]['writerEpoch'],
                           'expectedSequence': stored['sequence']-1, 'nextSequence': stored['sequence'],
                           'snapshotHash': stored['hash'], 'entries': stored['entries']}
                # Validate persisted data without imposing a new moving horizon.
                parse(canonical(request), self.policy, owner, max(self.clock(), state['wall']))
                if stored['validUntil'] != max([e['expiresAt'] for e in stored['entries']], default=0):
                    raise Rejected('checkpoint_expiry')
            return state
        except (ValueError, KeyError, TypeError) as exc:
            raise Rejected('checkpoint_invalid') from exc

    def save(self, state):
        fd, name = tempfile.mkstemp(prefix='.checkpoint-', dir=self.root)
        try:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(canonical(state))
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(name, self.root / 'checkpoint.json')
            directory = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def union(self, state, now):
        result = {port: {} for port in self.policy.ports}
        for owner, stored in state['owners'].items():
            # Wall-clock continuity across reboot is unproved. Never revive a
            # preboot observation; keep its CAS/hash until a fresh N+1 snapshot.
            if state['ownerBoots'][owner] != self.boot() or stored['validUntil'] <= now:
                continue
            for entry in stored['entries']:
                if entry['expiresAt'] > now:
                    target = result[entry['publishedPort']]
                    target[entry['ipv4']] = max(target.get(entry['ipv4'], 0), entry['expiresAt'])
        if sum(len(v) for v in result.values()) > CAPACITY:
            raise Rejected('union_overflow')
        return result

    def repair(self, state, union, wall, mono, boot, preserve_clock=False):
        """Kernel calls the durable barrier BEFORE any actual repair mutation.

        Hash equality proves desired intent only, never actual kernel state.
        A true no-op performs readback without an extra pending/kernel write.
        """
        desired = digest(union)
        barrier_done = False
        def pending():
            nonlocal barrier_done
            if not barrier_done:
                # Re-fsync a recovered pending mark too: its prior directory
                # sync may have failed. Exactly one barrier per mutating repair.
                state.update(pending=True, desiredHash=desired)
                self.save(state)
                barrier_done = True
        # Reference-v1 writes its barrier eagerly; current production uses the
        # adapter callback to avoid even checkpoint writes on a true no-op.
        try:
            pending()
            self.kernel.reconcile(union)
            # Only complete native readbacks can retire an existing pending mark.
            if state['pending'] or state['appliedHash'] != desired or boot != state['boot'] or wall-state['wall'] >= 1:
                state.update(pending=False, desiredHash=desired, appliedHash=desired)
                if not preserve_clock:
                    state.update(wall=wall, mono=mono, boot=boot)
                self.save(state)
        except BaseException:
            # Readback/fence failure is unavailable even if no swap was needed.
            # Also restore pending if the final applied checkpoint failed fsync.
            state.update(pending=True, desiredHash=desired)
            self.save(state)
            raise

    def execute(self, owner, request):
        # Caller holds the sole host lock for load, commit, all swaps and readback.
        state = self.load()
        wall, mono, boot = self.clock(), self.monotonic(), self.boot()
        if wall < state['wall'] or (boot == state['boot'] and wall + 1 < state['wall'] + mono - state['mono']):
            self.repair(state, {port: {} for port in self.policy.ports}, wall, mono, boot, preserve_clock=True)
            raise Rejected('clock_rollback')
        now = max(wall, state['wall'])
        previous = state['owners'].get(owner, {'sequence': 0, 'hash': None})
        if request['operation'] == 'apply':
            replay = request['nextSequence'] == previous['sequence'] and request['snapshotHash'] == previous['hash']
            if not replay:
                if request['expectedSequence'] != previous['sequence']:
                    raise Rejected('stale_or_conflict')
                if any(e['expiresAt'] <= now for e in request['entries']):
                    raise Rejected('expired_snapshot')
                state['ownerBoots'][owner] = boot
                state['owners'][owner] = {'sequence': request['nextSequence'], 'hash': request['snapshotHash'],
                    'epoch': request['writerEpoch'], 'entries': request['entries'],
                    'validUntil': max([e['expiresAt'] for e in request['entries']], default=0)}
                # Reject the complete ALL-owner union BEFORE durable commit.
                self.union(state, now)
                state.update(pending=True, desiredHash=digest(self.union(state, now)), wall=wall, mono=mono, boot=boot)
                self.save(state)
        union = self.union(state, now)
        self.repair(state, union, wall, mono, boot)
        current = state['owners'].get(owner, {'sequence': 0, 'hash': None})
        return {'version': 1, 'sequence': current['sequence'], 'snapshotHash': current['hash'],
                'pending': False, 'verdict': ('fresh_snapshot_required' if owner in state['owners'] and state['ownerBoots'][owner] != boot else 'applied'), 'entries': sum(map(len, union.values()))}
