#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""Fixed host effects for the shared gateway state machine (bug.5570).

Only JSON action/intent frames cross stdin. The caller receives nonsecret hashes.
The installed source manifest is the authority for host/custodian enrollment.
One process holds the shared runtime guard until EOF, including readiness waits.
"""
import base64
import datetime
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import shlex
import sys
import time
import urllib.request

LIB = Path(__file__).resolve().parent

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), LIB / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

guard = load('runtime-maintenance-guard')
receipt = load('runtime-recovery-receipt')
RUNTIME = Path('/opt/cogni-template-runtime')
ENV_FILE = RUNTIME / '.env'
COMPOSE_FILE = RUNTIME / 'docker-compose.yml'
MODEL_FILE = RUNTIME / 'configs/litellm.config.yaml'
ROOT = guard.ROOT
MANIFEST = ROOT / 'source.json'
DOCKER = ['docker', '--host', 'unix:///var/run/docker.sock']
KUBE = ['kubectl', '--kubeconfig', '/etc/rancher/k3s/k3s.yaml']
CHILD_ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8'}
COMPOSE = DOCKER + ['compose', '--project-name', 'cogni-runtime', '--env-file', str(ENV_FILE), '-f', str(COMPOSE_FILE)]
NAMESPACE = None
ACTIVE_GUARD_FD = None
ACTIONS = {'observe', 'prepare', 'install_render', 'activate', 'commit_receipt', 'rollback'}
TERMINAL = {'activated', 'rolled_back'}

class GatewayConflict(RuntimeError):
    pass

class GatewayUnhealthy(RuntimeError):
    pass

def digest(value):
    return hashlib.sha256(value).hexdigest()

def run(argv, *, input_bytes=None, timeout=30):
    # Neither stderr nor resolved config may cross the host boundary.
    return guard.run_native(ACTIVE_GUARD_FD, argv, input_bytes=input_bytes,
                            timeout=timeout, env=CHILD_ENV, cwd=RUNTIME)

def canonical_json(value):
    return receipt.canonical(value)

def atomic(path, data):
    receipt.atomic(path, data)

def env_value(data, key):
    matches = []
    for line in data.decode().splitlines():
        match = re.fullmatch(r'\s*(?:export\s+)?' + re.escape(key) + r'\s*=\s*(.*)', line)
        if match:
            words = shlex.split(match[1], comments=True)
            if len(words) != 1:
                raise RuntimeError('Invalid private environment field: ' + key)
            matches.append(words[0])
    if len(matches) != 1:
        raise RuntimeError('Expected exactly one private environment field: ' + key)
    return matches[0]

def replace_provider(data, value):
    if not re.fullmatch(r'sk-[A-Za-z0-9_-]+', value):
        raise RuntimeError('Invalid projected provider credential shape')
    env_value(data, 'OPENROUTER_API_KEY')
    pattern = rb'(?m)^[ \t]*(?:export[ \t]+)?OPENROUTER_API_KEY[ \t]*=.*$'
    result, count = re.subn(pattern, b'OPENROUTER_API_KEY=' + value.encode(), data)
    if count != 1:
        raise RuntimeError('Refuse missing or duplicate provider field')
    return result

def config():
    return json.loads(run(COMPOSE + ['config', '--format', 'json']))

def container(service, budget=30):
    ids = run(COMPOSE + ['ps', '--all', '-q', service], timeout=budget / 2).decode().split()
    if len(ids) != 1:
        raise RuntimeError('Expected one existing container: ' + service)
    return json.loads(run(DOCKER + ['inspect', ids[0]], timeout=budget / 2))[0]

def image_id(reference):
    return json.loads(run(DOCKER + ['image', 'inspect', reference]))[0]['Id']

def app_images():
    deployment = json.loads(run(KUBE + ['-n', NAMESPACE, 'get',
                                      'deployment', 'operator-node-app', '-o', 'json']))
    selector = ','.join(k + '=' + v for k, v in sorted(deployment['spec']['selector']['matchLabels'].items()))
    pods = json.loads(run(KUBE + ['-n', NAMESPACE, 'get', 'pods', '-l', selector, '-o', 'json']))
    return sorted([p['metadata']['uid'], c['name'], c.get('imageID')]
                  for p in pods['items'] if not p['metadata'].get('deletionTimestamp')
                  for c in p.get('status', {}).get('containerStatuses', []))

def container_signature(value):
    # Compare immutable process/container inputs and resource settings. The
    # selected provider field is the only permitted environment change.
    cfg = value['Config']
    host = value['HostConfig']
    return {'config': {k: cfg.get(k) for k in ['Entrypoint', 'Cmd', 'User', 'WorkingDir', 'Healthcheck', 'ExposedPorts', 'Volumes']},
            'environment': {k: v for k, v in current_environment(value).items() if k != 'OPENROUTER_API_KEY'},
            'host': {k: host.get(k) for k in ['Binds', 'Mounts', 'PortBindings', 'RestartPolicy', 'ReadonlyRootfs',
                     'Privileged', 'CapAdd', 'CapDrop', 'SecurityOpt', 'Memory', 'MemoryReservation', 'MemorySwap',
                     'NanoCpus', 'CpuShares', 'CpuQuota', 'CpuPeriod', 'PidsLimit', 'ShmSize', 'OomScoreAdj', 'NetworkMode']},
            'mounts': sorted((m['Type'], m['Source'], m['Destination'], m['RW'], m.get('Propagation')) for m in value['Mounts']),
            'networks': sorted((k, v['NetworkID'], sorted(a for a in (v.get('Aliases') or [])
                                  if a not in (value['Id'], value['Id'][:12])))
                               for k, v in value['NetworkSettings']['Networks'].items())}

def untouched_runtime():
    ids = run(DOCKER + ['ps', '-a', '--filter', 'label=com.docker.compose.project=cogni-runtime', '--format', '{{.ID}}']).decode().split()
    if not ids:
        raise RuntimeError('Runtime inventory is empty')
    result = {}
    for item in json.loads(run(DOCKER + ['inspect'] + ids)):
        # The scheduled backup is an independent one-shot reader. Its normal
        # completion/removal is not a stable service restart. This operation
        # never targets its container or data; keep stable services exact.
        service = item['Config'].get('Labels', {}).get('com.docker.compose.service')
        if service not in ('litellm', 'db-backup'):
            result[item['Name']] = {'id': item['Id'], 'image': item['Image'], 'startedAt': item['State']['StartedAt']}
    return result

def refuse_resource_drift(service, instance):
    host = instance['HostConfig']
    integer_fields = {'mem_limit': 'Memory', 'mem_reservation': 'MemoryReservation',
                      'cpu_shares': 'CpuShares', 'cpu_quota': 'CpuQuota', 'cpu_period': 'CpuPeriod'}
    for key, field in integer_fields.items():
        if int(service.get(key) or 0) != int(host.get(field) or 0):
            raise RuntimeError('Gateway resource settings differ from declaration')
    if int(float(service.get('cpus') or 0) * 1_000_000_000) != int(host.get('NanoCpus') or 0):
        raise RuntimeError('Gateway CPU settings differ from declaration')
    mem = int(service.get('mem_limit') or 0)
    if int(service.get('memswap_limit') if service.get('memswap_limit') is not None else 2 * mem) != int(host.get('MemorySwap') or 0):
        raise RuntimeError('Gateway swap settings differ from declaration')
    if max(0, int(service.get('pids_limit') or 0)) != max(0, int(host.get('PidsLimit') or 0)):
        raise RuntimeError('Gateway process limit differs from declaration')
    for key, field in [('cpuset', 'CpusetCpus'), ('cpuset_mems', 'CpusetMems')]:
        if (service.get(key) or '') != (host.get(field) or ''):
            raise RuntimeError('Gateway CPU affinity differs from declaration')
    for field in ['CpuRealtimePeriod', 'CpuRealtimeRuntime', 'KernelMemory', 'BlkioWeight']:
        if host.get(field) not in (None, 0):
            raise RuntimeError('Refuse a non-default mutable gateway resource')
    if host.get('MemorySwappiness') is not None or host.get('OomKillDisable') not in (None, False):
        raise RuntimeError('Refuse mutable gateway memory policy drift')
    if host.get('RestartPolicy', {}).get('Name') != service.get('restart', 'no') or host.get('RestartPolicy', {}).get('MaximumRetryCount', 0) != 0:
        raise RuntimeError('Gateway restart policy differs from declaration')
    for key, field in [('read_only', 'ReadonlyRootfs'), ('privileged', 'Privileged')]:
        if bool(service.get(key, False)) != bool(host.get(field, False)):
            raise RuntimeError('Gateway containment differs from declaration')

def declared_environment(service):
    value = service.get('environment', {})
    if not isinstance(value, dict):
        raise RuntimeError('Unexpected resolved environment shape')
    return value

def current_environment(instance):
    return dict(line.split('=', 1) for line in instance['Config']['Env'])

def app_sha():
    service = json.loads(run(KUBE + ['-n', NAMESPACE, 'get', 'service', 'operator-node-app', '-o', 'json']))
    ports = [p['nodePort'] for p in service['spec']['ports'] if p.get('port') == 3000 and p.get('nodePort')]
    if len(ports) != 1:
        raise RuntimeError('Candidate app NodePort unavailable')
    # The external public /version is verified separately by the caller. Native
    # NodePort identity avoids Cloudflare rejecting this VM's outbound IP.
    request = urllib.request.Request('http://127.0.0.1:' + str(ports[0]) + '/version', headers={'User-Agent': 'Cogni-key-recovery'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=15) as response:
        if response.status != 200:
            raise RuntimeError('Candidate app identity unavailable')
        return json.load(response)['buildSha']

def wait_gateway():
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        value = container('litellm', budget=max(0.05, min(30, deadline - time.monotonic())))['State']
        health = value.get('Health', {}).get('Status')
        if value.get('Running') and health == 'healthy':
            return
        if value.get('Status') in ('dead', 'exited'):
            break
        time.sleep(min(2, max(0, deadline - time.monotonic())))
    raise GatewayUnhealthy('gateway_unhealthy')

def recovery_config(value):
    return {'services': {name: value['services'][name] for name in ['postgres', 'litellm', 'autoheal']}}

def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()

def require(condition, reason):
    if not condition:
        raise GatewayConflict(reason)

def hash_file(path):
    return digest(guard.private_read(path))

def validate_intent(intent):
    require(set(intent) == {'version', 'operationId', 'target', 'env', 'custodian',
                            'implementationSha', 'protocolVersion', 'bindingRef'}, 'gateway_intent_shape')
    require(intent['version'] == 1 and intent['protocolVersion'] == 1, 'gateway_protocol_invalid')
    require(re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', intent['operationId']), 'gateway_operation_invalid')
    require(intent['target'] == 'litellm-provider-key', 'gateway_target_invalid')
    require(intent['env'] in ('candidate-a', 'preview', 'production'), 'gateway_environment_invalid')
    require(re.fullmatch(r'[a-f0-9]{40}', intent['implementationSha']), 'gateway_source_invalid')
    require(intent['bindingRef'] == 'cogni/' + intent['env'] + '/operator/OPENROUTER_API_KEY', 'gateway_binding_invalid')
    require(set(intent['custodian']) == {'owner', 'repo', 'controlEnv'} and
            intent['custodian']['controlEnv'] == 'production', 'gateway_custodian_invalid')
    for field in ('owner', 'repo'):
        require(re.fullmatch(r'[A-Za-z0-9_.-]+', intent['custodian'][field]), 'gateway_custodian_invalid')
    return intent

def binding(env):
    """Compare authoritative Bao bytes with the ESO-owned projection, in host memory."""
    external = json.loads(run(KUBE + ['-n', NAMESPACE, 'get', 'externalsecret', 'operator-env-secrets', '-o', 'json']))
    spec = external['spec']
    require(spec['secretStoreRef'] == {'kind': 'ClusterSecretStore', 'name': 'openbao-backend'}, 'gateway_store_mismatch')
    sources = spec.get('dataFrom', [])
    require(spec['target']['name'] == 'operator-env-secrets' and len(sources) == 1 and set(sources[0]) == {'extract'},
            'gateway_projection_source_mismatch')
    extract = sources[0]['extract']
    require(extract.get('key') == env + '/operator' and
            set(extract) <= {'key', 'conversionStrategy', 'decodingStrategy', 'metadataPolicy'} and
            extract.get('conversionStrategy', 'Default') == 'Default' and
            extract.get('decodingStrategy', 'None') == 'None' and extract.get('metadataPolicy', 'None') == 'None',
            'gateway_projection_source_mismatch')
    require(not any(item.get('secretKey') == 'OPENROUTER_API_KEY' for item in spec.get('data', [])),
            'gateway_projection_override_refused')
    require(any(c.get('type') == 'Ready' and c.get('status') == 'True' for c in external['status']['conditions']),
            'gateway_projection_not_ready')
    projected = json.loads(run(KUBE + ['-n', NAMESPACE, 'get', 'secret', 'operator-env-secrets', '-o', 'json']))
    require(any(o.get('uid') == external['metadata']['uid'] and o.get('kind') == 'ExternalSecret'
                for o in projected['metadata'].get('ownerReferences', [])), 'gateway_projection_owner_mismatch')
    store = json.loads(run(KUBE + ['get', 'clustersecretstore', 'openbao-backend', '-o', 'json']))['spec']['provider']['vault']
    require(store['server'] == 'http://openbao.openbao.svc.cluster.local:8200' and
            store['path'] == 'cogni' and store['version'] == 'v2', 'gateway_bao_store_mismatch')
    require(store['auth']['kubernetes'] == {'mountPath': 'kubernetes', 'role': 'eso-reader',
                                          'serviceAccountRef': {'name': 'external-secrets', 'namespace': 'external-secrets'}},
            'gateway_bao_auth_mismatch')
    service = json.loads(run(KUBE + ['-n', 'openbao', 'get', 'service', 'openbao', '-o', 'json']))
    ip = str(ipaddress.ip_address(service['spec']['clusterIP']))
    require(any(p['port'] == 8200 for p in service['spec']['ports']), 'gateway_bao_port_mismatch')
    origin = 'http://' + ('[' + ip + ']' if ':' in ip else ip) + ':8200/v1/'
    jwt = run(KUBE + ['-n', 'external-secrets', 'create', 'token', 'external-secrets', '--duration=10m']).decode().strip()
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    def bao(path, data=None, token=None):
        headers = {'Content-Type': 'application/json'}
        if token:
            headers['X-Vault-Token'] = token
        request = urllib.request.Request(origin + path, headers=headers,
                                         data=json.dumps(data).encode() if data is not None else None)
        with opener.open(request, timeout=10) as response:
            return json.load(response)
    token = bao('auth/kubernetes/login', {'role': 'eso-reader', 'jwt': jwt})['auth']['client_token']
    try:
        authority = bao('cogni/data/' + env + '/operator', token=token)['data']
    finally:
        # Revoke only this short-lived read session, never a provider credential.
        try:
            bao('auth/token/revoke-self', {}, token)
        except Exception:
            pass
    key = base64.b64decode(projected['data']['OPENROUTER_API_KEY'], validate=True).decode()
    require(key == authority['data']['OPENROUTER_API_KEY'], 'gateway_projection_stale')
    require(re.fullmatch(r'sk-[A-Za-z0-9_-]+', key), 'gateway_provider_shape_invalid')
    return key, {'uid': projected['metadata']['uid'], 'resourceVersion': projected['metadata']['resourceVersion'],
                 'externalUid': external['metadata']['uid'], 'keySha256': digest(key.encode()),
                 'vaultVersion': authority['metadata']['version']}

class Host:
    def __init__(self, intent):
        global NAMESPACE
        self.intent = validate_intent(intent)
        NAMESPACE = 'cogni-' + intent['env']
        self.directory = ROOT / 'operations' / intent['operationId']
        self.path = self.directory / 'operation.json'
        self.journal = None
        manifest = json.loads(guard.private_read(MANIFEST))
        require(manifest['protocolVersion'] == 1 and manifest['maintenanceEnabled'] is True, 'gateway_not_enrolled')
        require(manifest['env'] == intent['env'] and manifest['custodian'] == intent['custodian'], 'gateway_custodian_mismatch')
        require(manifest['implementationSha'] == intent['implementationSha'], 'gateway_implementation_not_qualified')
        require(manifest['machineId'] == Path('/etc/machine-id').read_text().strip(), 'gateway_machine_mismatch')
        cluster = json.loads(run(KUBE + ['get', 'namespace', 'kube-system', '-o', 'json']))['metadata']['uid']
        require(cluster == manifest['clusterUid'], 'gateway_cluster_mismatch')
        guard.validate_installation()
        for name in guard.HELPER_FILES:
            require(digest((LIB / name).read_bytes()) == manifest['blobs'][name], 'gateway_installed_source_mismatch')
        self.identity = {'machineId': manifest['machineId'], 'clusterUid': cluster}
        require(env_value(guard.private_read(ENV_FILE), 'DEPLOY_ENVIRONMENT') == intent['env'], 'gateway_runtime_environment_mismatch')
        for path in (COMPOSE_FILE, MODEL_FILE):
            require(path.is_file() and not path.is_symlink() and path.stat().st_uid == 0 and
                    not path.stat().st_mode & 0o022, 'gateway_installed_file_untrusted')
        if self.path.exists():
            self.journal = json.loads(guard.private_read(self.path))
            require(self.journal['intentDigest'] == digest(canonical_json(intent)) and
                    self.journal['identity'] == self.identity, 'gateway_journal_identity_mismatch')

    def save(self, state):
        self.journal['state'] = state
        self.journal['updatedAt'] = now()
        atomic(self.path, canonical_json(self.journal) + b'\n')

    def selected(self):
        key, projection = binding(self.intent['env'])
        require(projection == self.journal['projection'], 'gateway_binding_superseded')
        return key

    def preserved(self, check_app=True):
        j = self.journal
        require(digest(COMPOSE_FILE.read_bytes()) == j['composeSha256'] and
                digest(MODEL_FILE.read_bytes()) == j['modelSha256'], 'gateway_declaration_changed')
        if check_app:
            require(app_images() == j['appImages'] and app_sha() == j['appSha'], 'gateway_app_changed')
        require(untouched_runtime() == j['untouchedRuntime'], 'gateway_other_runtime_changed')
        require(image_id(j['imageRef']) == j['imageId'], 'gateway_local_image_changed')

    def gateway_matches(self, key_hash):
        instance = container('litellm')
        require(instance['Image'] == self.journal['imageId'], 'gateway_process_image_changed')
        require(digest(canonical_json(container_signature(instance))) == self.journal['gatewaySignature'],
                'gateway_process_config_changed')
        return digest(current_environment(instance)['OPENROUTER_API_KEY'].encode()) == key_hash

    def render_matches(self, state):
        j = self.journal
        require(hash_file(ENV_FILE) == j[state + 'EnvSha256'], 'gateway_render_changed')
        require(digest(canonical_json(config())) == j[state + 'ConfigSha256'],
                'gateway_config_delta_invalid')

    def prepare(self):
        require(self.journal is None, 'gateway_already_prepared')
        old = guard.private_read(ENV_FILE)
        cfg = config()
        gateway = container('litellm')
        require(cfg['services']['litellm'].get('labels', {}).get('autoheal') == 'false' and
                gateway['Config'].get('Labels', {}).get('autoheal') == 'false', 'gateway_competing_autoheal_writer')
        require(not cfg['services']['litellm'].get('build'), 'gateway_build_not_allowed')
        refuse_resource_drift(cfg['services']['litellm'], gateway)
        native_hash = run(COMPOSE + ['config', '--hash', 'litellm']).decode().split()
        require(len(native_hash) == 2 and native_hash[1] == gateway['Config']['Labels'].get('com.docker.compose.config-hash'),
                'gateway_compose_process_drift')
        require(all(current_environment(gateway).get(k) == v for k, v in declared_environment(cfg['services']['litellm']).items()),
                'gateway_environment_drift')
        key, projection = binding(self.intent['env'])
        replacement = replace_provider(old, key)
        raw_receipt = receipt.read_bytes()
        previous = receipt.validate(json.loads(raw_receipt))
        require(previous['composeSha256'] == digest(COMPOSE_FILE.read_bytes()) and
                previous['litellmConfigSha256'] == digest(MODEL_FILE.read_bytes()) and
                previous['recoveryServiceConfigSha256'] == digest(canonical_json(recovery_config(cfg))), 'gateway_recovery_receipt_drift')
        for name, image in previous['images'].items():
            require(cfg['services'][name]['image'] == image['ref'] and image_id(image['ref']) == image['id'] and
                    container(name)['Image'] == image['id'], 'gateway_recovery_image_drift')
        app = app_images()
        require(bool(app) and all(i[2] for i in app), 'gateway_app_identity_missing')
        guard.private_directory(self.directory)
        # Before a durable journal there are no installed effects. Prior-state
        # backups must still match the live bytes. A partial desired backup is
        # only staging and may be refreshed from the current canonical projection.
        for name, data in [('before.env', old), ('desired.env', replacement), ('before-receipt.json', raw_receipt)]:
            path = self.directory / name
            require(name == 'desired.env' or not path.exists() or guard.private_read(path) == data,
                    'gateway_prepare_backup_conflict')
            atomic(path, data)
        # Resolve the private desired render before replacing the installed one.
        # An unexpected interpolation cannot leave the live render half-changed.
        desired_command = DOCKER + ['compose', '--project-name', 'cogni-runtime', '--env-file',
                                    str(self.directory / 'desired.env'), '-f', str(COMPOSE_FILE), 'config', '--format', 'json']
        desired_config = json.loads(run(desired_command))
        expected_config = json.loads(json.dumps(cfg))
        for service in expected_config['services'].values():
            values = service.get('environment', {})
            if values.get('OPENROUTER_API_KEY') == env_value(old, 'OPENROUTER_API_KEY'):
                values['OPENROUTER_API_KEY'] = key
        require(desired_config == expected_config, 'gateway_desired_config_delta_invalid')
        self.journal = {
            'version': 1, 'operationId': self.intent['operationId'], 'intentDigest': digest(canonical_json(self.intent)),
            'identity': self.identity, 'projection': projection, 'appSha': app_sha(), 'appImages': app,
            'untouchedRuntime': untouched_runtime(), 'beforeEnvSha256': digest(old), 'desiredEnvSha256': digest(replacement),
            'beforeReceiptSha256': digest(raw_receipt), 'composeSha256': digest(COMPOSE_FILE.read_bytes()),
            'modelSha256': digest(MODEL_FILE.read_bytes()), 'imageRef': cfg['services']['litellm']['image'],
            'imageId': gateway['Image'], 'beforeContainerId': gateway['Id'],
            'beforeProviderKeySha256': digest(env_value(old, 'OPENROUTER_API_KEY').encode()),
            'gatewaySignature': digest(canonical_json(container_signature(gateway))),
            'beforeConfigSha256': digest(canonical_json(cfg)), 'desiredConfigSha256': digest(canonical_json(desired_config)),
        }
        self.save('prepared')

    def install_render(self):
        require(self.journal['state'] == 'prepared', 'gateway_phase_conflict')
        self.preserved()
        self.selected()
        j = self.journal
        current = hash_file(ENV_FILE)
        # A lost response after rename leaves phase=prepared with desired bytes.
        require(current in (j['beforeEnvSha256'], j['desiredEnvSha256']), 'gateway_render_changed')
        require(digest(receipt.read_bytes()) == j['beforeReceiptSha256'], 'gateway_receipt_changed')
        require(container('litellm')['Id'] == j['beforeContainerId'], 'gateway_before_container_changed')
        require(self.gateway_matches(j['beforeProviderKeySha256']), 'gateway_before_binding_changed')
        desired = guard.private_read(self.directory / 'desired.env')
        require(digest(desired) == j['desiredEnvSha256'], 'gateway_backup_changed')
        if current != j['desiredEnvSha256']:
            atomic(ENV_FILE, desired)
        self.render_matches('desired')
        self.save('render_installed')

    def activate(self):
        require(self.journal['state'] in ('render_installed', 'recreate_started'), 'gateway_phase_conflict')
        self.preserved()
        self.selected()
        self.render_matches('desired')
        j = self.journal
        adopted = self.gateway_matches(j['projection']['keySha256'])
        if not adopted:
            require(container('litellm')['Id'] == j['beforeContainerId'] and
                    self.gateway_matches(j['beforeProviderKeySha256']), 'gateway_unknown_container')
            self.save('recreate_started')
            # Docker handles bounded SIGTERM before kill; no other service participates.
            run(COMPOSE + ['up', '-d', '--no-deps', '--pull', 'never', '--no-build', '--timeout', '20',
                           '--force-recreate', 'litellm'], timeout=60)
        wait_gateway()
        self.preserved()
        require(self.gateway_matches(j['projection']['keySha256']), 'gateway_binding_not_adopted')
        self.save('gateway_verified')

    def commit_receipt(self):
        j = self.journal
        require(j['state'] in ('gateway_verified', 'receipt_commit_started'), 'gateway_phase_conflict')
        self.preserved()
        self.selected()
        self.render_matches('desired')
        require(self.gateway_matches(j['projection']['keySha256']), 'gateway_binding_not_adopted')
        wait_gateway()
        if j['state'] == 'gateway_verified':
            before = guard.private_read(self.directory / 'before-receipt.json')
            require(digest(before) == j['beforeReceiptSha256'], 'gateway_backup_changed')
            value = receipt.validate(json.loads(before))
            value['recoveryServiceConfigSha256'] = digest(canonical_json(recovery_config(config())))
            value['completedAt'] = now()
            value = receipt.seal(value)
            encoded = canonical_json(value) + b'\n'
            atomic(self.directory / 'desired-receipt.json', encoded)
            j['desiredReceiptSha256'] = digest(encoded)
            self.save('receipt_commit_started')
        desired = guard.private_read(self.directory / 'desired-receipt.json')
        require(digest(desired) == j['desiredReceiptSha256'], 'gateway_backup_changed')
        actual = digest(receipt.read_bytes())
        require(actual in (j['beforeReceiptSha256'], j['desiredReceiptSha256']), 'gateway_receipt_changed')
        if actual != j['desiredReceiptSha256']:
            receipt.commit(json.loads(desired), j['beforeReceiptSha256'])
        self.preserved()
        require(digest(receipt.read_bytes()) == j['desiredReceiptSha256'], 'gateway_receipt_commit_failed')
        self.save('activated')

    def rollback(self):
        j = self.journal
        require(j['state'] in ('prepared', 'render_installed', 'recreate_started', 'gateway_verified', 'receipt_commit_started', 'rollback_started'),
                'gateway_rollback_phase_conflict')
        # Compensation restores only journal-bound prior state. It does not
        # select or install the newer canonical projection, or touch app pods.
        self.preserved(check_app=False)
        require(hash_file(ENV_FILE) in (j['beforeEnvSha256'], j['desiredEnvSha256']), 'gateway_render_changed')
        actual = digest(receipt.read_bytes())
        require(actual in {j['beforeReceiptSha256'], j.get('desiredReceiptSha256')}, 'gateway_receipt_changed')
        old = guard.private_read(self.directory / 'before.env')
        prior = guard.private_read(self.directory / 'before-receipt.json')
        require(digest(old) == j['beforeEnvSha256'] and digest(prior) == j['beforeReceiptSha256'], 'gateway_backup_changed')
        # Observe before repeating rollback. Unknown containers never authorize a replacement.
        restored = self.gateway_matches(j['beforeProviderKeySha256'])
        if not restored:
            require(self.gateway_matches(j['projection']['keySha256']), 'gateway_rollback_unknown_container')
        self.save('rollback_started')
        if hash_file(ENV_FILE) != j['beforeEnvSha256']:
            atomic(ENV_FILE, old)
        if not restored:
            run(COMPOSE + ['up', '-d', '--no-deps', '--pull', 'never', '--no-build', '--timeout', '20',
                           '--force-recreate', 'litellm'], timeout=60)
        wait_gateway()
        self.preserved(check_app=False)
        self.render_matches('before')
        require(self.gateway_matches(j['beforeProviderKeySha256']), 'gateway_rollback_binding_failed')
        # Preserve the exact prior bytes, including the preexisting wire encoding.
        if digest(receipt.read_bytes()) != j['beforeReceiptSha256']:
            require(digest(receipt.read_bytes()) == j['desiredReceiptSha256'], 'gateway_receipt_changed')
            receipt.validate(json.loads(prior))
            atomic(receipt.RECEIPT, prior)
        try:
            j['appPreserved'] = app_images() == j['appImages'] and app_sha() == j['appSha']
            j['appShaAfterRecovery'] = app_sha()
        except Exception:
            j['appPreserved'] = False
        self.save('rolled_back')

    def reconcile_conflict(self, reason):
        require(reason in ('gateway_binding_superseded', 'gateway_app_changed'), 'gateway_conflict_not_reconcilable')
        require(self.journal is not None and self.journal['state'] not in TERMINAL, 'gateway_conflict_not_pending')
        self.journal['resolutionReason'] = reason
        self.save(self.journal['state'])
        self.rollback()
        return self.observation(reason)

    def observation(self, failure=None):
        j = self.journal
        result = {'operationId': self.intent['operationId'], 'phase': j['state'] if j else 'unstarted', 'observedAt': now()}
        if failure:
            result['failure'] = failure
        if j:
            result['evidence'] = {'appSha': j['appSha'], 'gatewayImage': j['imageId'],
                                  'selectedProviderKeySha256': j['projection']['keySha256'],
                                  'projectionUid': j['projection']['uid'],
                                  'projectionResourceVersion': j['projection']['resourceVersion'],
                                  'otherRuntimeCount': len(j['untouchedRuntime'])}
            if j['state'] == 'activated':
                result['evidence']['providerKeySha256'] = j['projection']['keySha256']
            elif j['state'] == 'rolled_back':
                result['evidence']['providerKeySha256'] = j['beforeProviderKeySha256']
                result['evidence']['appPreserved'] = j.get('appPreserved', False)
                if j.get('appShaAfterRecovery'):
                    result['evidence']['appShaAfterRecovery'] = j['appShaAfterRecovery']
                if not j.get('appPreserved', False):
                    result['currentQualified'] = False
        if j and j.get('resolutionReason') and not failure:
            result['failure'] = j['resolutionReason']
        return result

    def step(self, action):
        if action == 'observe':
            if self.journal and self.journal['state'] in TERMINAL:
                result = self.observation()
                result['noChanges'] = True
                try:
                    self.preserved()
                    state = 'desired' if self.journal['state'] == 'activated' else 'before'
                    self.render_matches(state)
                    key_hash = self.journal['projection']['keySha256'] if state == 'desired' else self.journal['beforeProviderKeySha256']
                    require(self.gateway_matches(key_hash), 'gateway_terminal_binding_drift')
                    expected_receipt = self.journal[state + 'ReceiptSha256']
                    require(digest(receipt.read_bytes()) == expected_receipt, 'gateway_terminal_receipt_drift')
                    if self.journal['state'] == 'activated':
                        self.selected()
                    wait_gateway()
                    result['currentQualified'] = True
                except GatewayConflict as error:
                    result['failure'] = str(error)
                    result['currentQualified'] = False
                except Exception:
                    result['failure'] = 'gateway_current_evidence_unavailable'
                    result['currentQualified'] = False
                return result
            return self.observation()
        getattr(self, action)()
        return self.observation()

def serve():
    global ACTIVE_GUARD_FD
    # Keep the native protocol bounded; never let a caller stream arbitrary commands.
    first = sys.stdin.buffer.readline(16385)
    require(len(first) <= 16384, 'gateway_frame_oversized')
    frame = json.loads(first)
    require(set(frame) == {'action', 'intent'} and frame['action'] == 'observe', 'gateway_initial_frame_invalid')
    intent = validate_intent(frame['intent'])
    with guard.RuntimeGuard(intent['operationId']) as active_guard:
        # A surviving native child retains exclusion after parent-only death.
        # Same-UUID recovery cannot enter until that execution has exited.
        ACTIVE_GUARD_FD = active_guard.stream.fileno()
        host = Host(intent)
        for index in range(13):
            require(frame['intent'] == intent and frame['action'] in ACTIONS, 'gateway_frame_invalid')
            try:
                result = host.step(frame['action'])
            except GatewayUnhealthy:
                result = host.observation('gateway_unhealthy')
            except GatewayConflict as error:
                if str(error) in ('gateway_binding_superseded', 'gateway_app_changed') and host.journal:
                    try:
                        result = host.reconcile_conflict(str(error))
                    except (GatewayConflict, GatewayUnhealthy):
                        result = host.observation(str(error))
                        result['phase'] = 'conflict'
                else:
                    result = host.observation(str(error))
                    result['phase'] = 'conflict'
            print(json.dumps(result), flush=True)
            line = sys.stdin.buffer.readline(16385)
            if not line:
                return
            require(len(line) <= 16384 and index < 12, 'gateway_frame_bound')
            frame = json.loads(line)
            require(set(frame) == {'action', 'intent'}, 'gateway_frame_invalid')

if __name__ == '__main__':
    try:
        require(sys.argv[1:] == ['serve'], 'gateway_serve_only')
        serve()
    except Exception:
        # An unknown transport/native failure is not a rollback verdict. The same
        # UUID resumes the durable journal. Private values and tracebacks stay here.
        print('gateway_host_incomplete', file=sys.stderr)
        raise SystemExit(1)
