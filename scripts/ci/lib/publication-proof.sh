#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Bounded, read-only publication adapter. No release state, retries or writers.
# Callers own credentials, catalog data and (for publishers) the native job lock.

publication_is_operator_coordinate() {
  local repository="${1%%@*}"
  repository="${repository%%:*}"
  local owner="${GITHUB_REPOSITORY_OWNER:-cogni-dao}"
  [[ "$repository" == "ghcr.io/${owner,,}/cogni-template" || "$repository" == "ghcr.io/${owner,,}/cogni-template-migrate" ]]
}

publication_require_verifier() {
  local help flag
  help=$(timeout 20 gh attestation verify --help) || return 1
  for flag in --signer-workflow --predicate-type --format --limit --bundle --bundle-from-oci; do
    [[ "$help" == *"$flag"* ]] || { echo "publication_verifier_unsupported: $flag" >&2; return 1; }
  done
}

# 0 = present; 3 = positively absent; 1 = unresolved/auth/transport failure.
# A failed read must never authorize replacement of a closed coordinate.
publication_lookup() {
  local tag="$1" result diagnostic err rc=0
  err=$(mktemp)
  result=$(timeout 60 docker buildx imagetools inspect "$tag" --format '{{json .Manifest.Digest}}' 2>"$err") || rc=$?
  if [[ "$rc" == 0 && "${result//\"/}" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '%s@%s\n' "${tag%%:*}" "${result//\"/}"
    rm -f "$err"
    return 0
  fi
  # Buildx often reduces the registry's typed 404 to "not found". Confirm
  # missing-manifest with the authenticated registry API; never infer absence
  # from that lossy diagnostic, an anonymous 404, or a missing repository.
  # Identity bytes are opaque: a source SHA may contain 503/595 and a target
  # may be named connection/denied. Classify only the diagnostic after removing
  # the EXACT requested coordinate. Typed authenticated confirmation below is
  # still the sole authority for absence.
  diagnostic=$(cat "$err")
  diagnostic="${diagnostic//"$tag"/}"
  if [[ "$rc" != 0 ]] && grep -Eqi 'manifest unknown|MANIFEST_UNKNOWN|not found' <<<"$diagnostic" &&
      ! grep -Eqi 'unauthorized|denied|forbidden|timeout|connection|5[0-9][0-9]' <<<"$diagnostic"; then
    local absence_rc=0
    publication_confirm_absence "$tag" || absence_rc=$?
    if [[ "$absence_rc" = 3 ]]; then rm -f "$err"; return 3; fi
  fi
  echo "publication_lookup_failed: $tag" >&2
  cat "$err" >&2
  rm -f "$err"
  return 1
}

# Docker's existing login is the credential owner. This bounded read preserves
# the Registry API's typed distinction between missing manifest and failed read.
publication_confirm_absence() {
  python3 - "$1" <<'PYTHON'
import base64, json, os, pathlib, re, subprocess, sys, tempfile
from urllib.parse import urlencode
tag = sys.argv[1]
m = re.fullmatch(r'ghcr.io/([a-z0-9._/-]+):([a-zA-Z0-9_.-]+)', tag)
if not m: raise SystemExit('publication_registry_coordinate_invalid')
username, password = os.environ.get('GHCR_USERNAME'), os.environ.get('GHCR_TOKEN')
if not (username and password):
    cfg = json.loads(pathlib.Path(os.environ.get('DOCKER_CONFIG', str(pathlib.Path.home() / '.docker')), 'config.json').read_text())
    auth = cfg.get('auths', {}).get('ghcr.io', {}).get('auth')
    if auth:
        username, password = base64.b64decode(auth).decode().split(':', 1)
    else:
        helper = cfg.get('credHelpers', {}).get('ghcr.io') or cfg.get('credsStore')
        if not helper or not re.fullmatch('[a-zA-Z0-9_-]+', helper):
            raise SystemExit('publication_registry_auth_missing')
        p = subprocess.run(['docker-credential-' + helper, 'get'], input=b'ghcr.io', capture_output=True, timeout=20, check=True)
        c = json.loads(p.stdout); username, password = c['Username'], c['Secret']
def request(url, authorization):
    # Pass the sensitive header through stdin, never shell interpolation/logs.
    with tempfile.TemporaryDirectory() as directory:
        output = pathlib.Path(directory, 'body')
        p = subprocess.run(['curl', '--config', '-', '--silent', '--show-error', '--connect-timeout', '10',
                            '--max-time', '30', '--max-filesize', '1048576', '--output', str(output),
                            '--write-out', '%{http_code}', url],
                           input=('header = "Authorization: ' + authorization + '"\n').encode(),
                           capture_output=True, timeout=40)
        if p.returncode or not output.exists(): raise SystemExit('publication_registry_transport_failed')
        return p.stdout.decode(), json.loads(output.read_bytes())
basic = base64.b64encode((username + ':' + password).encode()).decode()
status, result = request('https://ghcr.io/token?' + urlencode({'service':'ghcr.io','scope':f'repository:{m[1]}:pull'}), 'Basic ' + basic)
if status != '200' or not isinstance(result.get('token'), str) or not re.fullmatch(r'[A-Za-z0-9._~+/=-]+', result['token']):
    raise SystemExit('publication_registry_auth_failed')
status, result = request(f'https://ghcr.io/v2/{m[1]}/manifests/{m[2]}', 'Bearer ' + result['token'])
if status == '404' and result.get('errors') and all(x.get('code') == 'MANIFEST_UNKNOWN' for x in result['errors']):
    raise SystemExit(3)
raise SystemExit('publication_registry_lookup_unresolved')
PYTHON
}

# Recipe bytes are obtained from the actual source repository, not from image
# claims. Local source must be the exact checked-out commit; readers use GitHub.
publication_recipe() {
  local repository="$1" sha="$2" target="$3" root="${4:-}"
  python3 - "$repository" "$sha" "$target" "$root" <<'PY'
import base64, hashlib, json, pathlib, re, subprocess, sys
repo, sha, target, root = sys.argv[1:]
if not re.fullmatch(r'[\w.-]+/[\w.-]+', repo) or not re.fullmatch('[a-f0-9]{40}', sha) or not re.fullmatch('[a-z0-9-]+', target):
    raise SystemExit('publication_identity_invalid')
def run(args):
    return subprocess.check_output(args, timeout=60)
def blob(path):
    if root:
        if run(['git', '-C', root, 'rev-parse', 'HEAD']).decode().strip() != sha:
            raise SystemExit('publication_checkout_mismatch')
        return run(['git', '-C', root, 'show', f'{sha}:{path}'])
    value = json.loads(run(['gh', 'api', f'repos/{repo}/contents/{path}?ref={sha}']))
    return base64.b64decode(value['content'], validate=False)
catalog = blob(f'infra/catalog/{target}.yaml')
# yq is the same catalog parser used by the build owner. The recipe contains
# build inputs only, so environment/catalog-only edits cannot alter its identity.
c = json.loads(subprocess.check_output(['yq', '-o=json', '.'], input=catalog, timeout=20))
dockerfile = c['dockerfile']
if not isinstance(dockerfile, str) or pathlib.PurePosixPath(dockerfile).is_absolute() or '..' in pathlib.PurePosixPath(dockerfile).parts:
    raise SystemExit('publication_recipe_invalid')
recipe = {'dockerfile': dockerfile, 'dockerfile_sha256': hashlib.sha256(blob(dockerfile)).hexdigest(),
          'context': c.get('build_context', '.'), 'stage': 'runner' if c['type'] == 'node' else '',
          'platform': 'linux/amd64'}
print(hashlib.sha256(json.dumps(recipe, sort_keys=True, separators=(',', ':')).encode()).hexdigest())
PY
}

# Exact immutable subject. Signed bundles are native Sigstore bundles, never
# assertions from a fragment. A retained bundle is reverified by gh on every use.
publication_verify() {
  local ref="$1" repository="$2" sha="$3" target="$4" output="$5" bundle="${6:-}"
  rm -f "$output"
  python3 - "$ref" "$repository" "$sha" "$target" "$output" "$bundle" \
    "$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)" <<'PY'
import base64, hashlib, io, json, os, pathlib, re, subprocess, sys, tempfile, zipfile
ref, source_repo, source_sha, target, output, retained, tooling = sys.argv[1:]
MAX = 32 * 1024 * 1024
repo = os.environ.get('GITHUB_REPOSITORY', 'cogni-dao/cogni')
workflow = '.github/workflows/pr-build.yml'
# Actual legacy definition at f66aae9e (also the three saved historical runs).
# GitHub's authenticated contents response binds these blobs to the named tree.
legacy_blobs = {
    workflow: '6f43c32fbaf414f3c2919a4c0448cb83a75cacd0',
    'scripts/ci/build-and-push-images.sh': 'f52e1cd23a4758dbff2cd78ee0741113cf3761ba',
    'scripts/ci/lib/image-tags.sh': 'e50000359244f0d52024acbf4265897c9ae67b8c',
    'scripts/ci/merge-build-fragments.sh': 'c7b18a6dbef51d19223d4afeb0680573b416748e',
    'scripts/ci/write-build-manifest.sh': '02da0177a038bdad230d33b850281890e21fb4d1',
}
image, digest = ref.split('@', 1)
if not re.fullmatch(r'ghcr.io/[a-z0-9._/-]+', image) or not re.fullmatch(r'sha256:[a-f0-9]{64}', digest):
    raise SystemExit('publication_subject_invalid')
if not re.fullmatch('[a-f0-9]{40}', source_sha) or not re.fullmatch(r'[\w.-]+/[\w.-]+', source_repo):
    raise SystemExit('publication_source_invalid')
read_total = 0
def run(args):
    global read_total
    p = subprocess.run(args, capture_output=True, timeout=120)
    read_total += len(p.stdout) + len(p.stderr)
    if read_total > MAX:
        raise RuntimeError('publication_read_bound')
    if p.returncode:
        raise RuntimeError(p.stderr.decode(errors='replace')[-2000:])
    return p.stdout
def api(path):
    return json.loads(run(['gh', 'api', path]))
def remote_blob(repository, revision, path):
    d = api(f'repos/{repository}/contents/{path}?ref={revision}')
    return base64.b64decode(d['content'])
# Independently qualified original-publication closure at 29e194. Retain this
# explicit history when current tooling evolves. The old reader is NOT trusted
# to qualify itself. See PR3000 issuecomment-6552584585 for the bounded review.
retained_native_blobs = {
    workflow: '974a71f16a47781df8ca8fc932a4a4dc047981a8',
    'scripts/ci/build-and-push-images.sh': '3a2b343a4e1cb611b39a7935a1f4311ac85a7420',
    'scripts/ci/lib/publication-proof.sh': '57e31dc98dfb81f139d4bb4cb9a6261f6a0922b0',
    'scripts/ci/lib/image-tags.sh': 'e50000359244f0d52024acbf4265897c9ae67b8c',
}
# R54 qualified the complete 02a72 original native publication path. Its sole
# Spec blocker is the legacy reader repaired below, not native nomination.
# Preserve those already published originals as this reader's bytes evolve.
previous_native_blobs = {
    workflow: 'bad3a08547715d47c5808d6ca65984b6ca910a75',
    'scripts/ci/build-and-push-images.sh': '3a2b343a4e1cb611b39a7935a1f4311ac85a7420',
    'scripts/ci/lib/publication-proof.sh': 'ecab36a3d7c205207b5bdfbfe720def48d1b6cd2',
    'scripts/ci/lib/image-tags.sh': 'e50000359244f0d52024acbf4265897c9ae67b8c',
}
def git_blob(data):
    return hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
def trusted_current_closure():
    # Native runner context selects C, never application/label/CLI input. Exact
    # review + authorized workflow execution remains the independent authority.
    current = os.environ.get('GITHUB_WORKFLOW_SHA', '')
    executing = os.environ.get('GITHUB_WORKFLOW_REF', '')
    m = re.fullmatch(re.escape(repo) + r'/(\.github/workflows/[^/@]+\.ya?ml)@.+', executing)
    if not re.fullmatch('[a-f0-9]{40}', current) or not m:
        raise RuntimeError('publication_reader_context_invalid')
    if run(['git', '-C', tooling, 'rev-parse', 'HEAD']).decode().strip() != current:
        raise RuntimeError('publication_reader_revision_mismatch')
    expected = {}
    # Include the executing reader workflow as well as the producer closure.
    for path in dict.fromkeys((*retained_native_blobs, m[1])):
        immutable = run(['git', '-C', tooling, 'show', f'{current}:{path}'])
        if pathlib.Path(tooling, path).read_bytes() != immutable:
            raise RuntimeError('publication_reader_worktree_mismatch: ' + path)
        if path in retained_native_blobs:
            expected[path] = git_blob(immutable)
    return expected
try:
    current_native_blobs = trusted_current_closure()
except (RuntimeError, OSError) as error:
    raise SystemExit('publication_unverified: ' + str(error))
def qualify_producer_closure(revision):
    # Recompute authenticated content hashes; do not trust a response's claimed
    # blob id alone. Every transport calls this before source labels mean proof.
    actual = {path: git_blob(remote_blob(repo, revision, path)) for path in retained_native_blobs}
    if actual != current_native_blobs and actual != retained_native_blobs and actual != previous_native_blobs:
        raise RuntimeError('publication_signer_implementation_mismatch')
def legacy_app_checkout(job, run_id, attempt):
    checkout = 'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955'
    # These are the actual frozen W step names/numbers, including custom names.
    # The manifest's unsigned claims depend on its app-side merge/write chain.
    names = (['Set up Docker Buildx', 'Login to GHCR', f'Build and push {target}', 'Upload build fragment']
             if job['name'] == f'build ({target})' else
             ['Download build fragments', 'Merge fragments into build-images.json', 'Write build manifest', 'Upload build manifest'])
    names = ['Set up job', 'Run ' + checkout] + names
    if (str(job.get('run_id')) != run_id or str(job.get('run_attempt')) != attempt
            or [(x.get('number'), x.get('name'), x.get('conclusion')) for x in job.get('steps', [])[:6]] !=
               [(i, name, 'success') for i, name in enumerate(names, 1)]):
        raise SystemExit('publication_legacy_checkout_unproven: step chain')
    logs = run(['gh', 'api', f'repos/{repo}/actions/jobs/{job["id"]}/logs']).decode('utf-8-sig')
    lines = [re.sub(r'^\d{4}-\d\d-\d\dT[0-9:.]+Z ', '', line) for line in logs.splitlines()]
    marker = 'Complete job name: ' + job['name']
    if lines.count(marker) != 1:
        raise SystemExit('publication_legacy_checkout_unproven: job boundary')
    header = lines[lines.index(marker) + 1:]
    if not header or header[0] != '##[group]Run ' + checkout or '##[endgroup]' not in header:
        raise SystemExit('publication_legacy_checkout_unproven: first action')
    end = header.index('##[endgroup]')
    # Native runner inputs precede action execution. Never scan arbitrary tail
    # text for a repository/ref. No server, path, sparse, shell or env override.
    defaults = {'repository': source_repo, 'ref': source_sha, 'fetch-depth': '1', 'token': '***',
                'ssh-strict': 'true', 'ssh-user': 'git', 'persist-credentials': 'true',
                'clean': 'true', 'sparse-checkout-cone-mode': 'true', 'fetch-tags': 'false',
                'show-progress': 'true', 'lfs': 'false', 'submodules': 'false', 'set-safe-directory': 'true'}
    values, environment, section = {}, {}, None
    for line in header[1:end]:
        if line in ('with:', 'env:'):
            if (line == 'with:' and section is not None) or (line == 'env:' and section != 'with:'):
                raise SystemExit('publication_legacy_checkout_unproven: header sections')
            section = line
            continue
        m = re.fullmatch(r'  ([A-Za-z_][A-Za-z0-9_-]*): (.*)', line)
        if not m or section is None:
            raise SystemExit('publication_legacy_checkout_unproven: input shape')
        destination = values if section == 'with:' else environment
        if m[1] in destination:
            raise SystemExit('publication_legacy_checkout_unproven: duplicate input')
        destination[m[1]] = m[2]
    if (any(k not in defaults or defaults[k] != v for k, v in values.items())
            or not all(values.get(k) == defaults[k] for k in ('repository', 'ref', 'fetch-depth'))):
        raise SystemExit('publication_legacy_checkout_unproven: checkout inputs')
    env_values = {'IMAGE_NAME': 'ghcr.io/' + repo.split('/')[0] + '/cogni-template',
                  'HEAD_SHA': source_sha, 'IMAGE_TAG': 'sha-' + source_sha}
    if (any(k not in {*env_values, 'FLEET_CONTROL_ENV', 'PR_NUMBER'} for k in environment)
            or any(environment.get(k) != v for k, v in env_values.items())
            or not re.fullmatch('[a-z][a-z0-9-]*', environment.get('FLEET_CONTROL_ENV', ''))
            or not re.fullmatch('[0-9]*', environment.get('PR_NUMBER', ''))):
        raise SystemExit('publication_legacy_checkout_unproven: checkout environment')
    body = header[end + 1:]
    boundary = next((i for i, line in enumerate(body) if line.startswith('##[group]Run ') or line == 'Post job cleanup.'), len(body))
    body = body[:boundary]
    positions = [i for i, line in enumerate(body) if line == '[command]/usr/bin/git log -1 --format=%H']
    if (len(positions) != 1 or positions[0] + 1 >= len(body) or body[positions[0] + 1] != source_sha
            or [line for line in body if line.startswith('Syncing repository: ')] != ['Syncing repository: ' + source_repo]
            or [line for line in body if line.startswith('[command]/usr/bin/git checkout ')] !=
               ['[command]/usr/bin/git checkout --progress --force ' + source_sha]):
        raise SystemExit('publication_legacy_checkout_unproven: checkout result')

def legacy_workflow_revision(original, jobs, run_id, attempt):
    # REST head_sha is the PR app head, NOT the merge execution revision.
    # Only these original event families execute the REST head itself.
    event = original.get('event')
    if event in ('push', 'merge_group', 'workflow_dispatch'):
        revision = original.get('head_sha', '')
        if not re.fullmatch('[a-f0-9]{40}', revision):
            raise SystemExit('publication_legacy_execution_unresolved')
        return revision
    if event != 'pull_request':
        raise SystemExit('publication_legacy_execution_unresolved')
    # The frozen workflow's first classifier action has NO ref override. The
    # pinned checkout therefore reads the native event merge SHA. Authenticate
    # the original attempt/job and its FIRST runner-issued action header before
    # reading checkout output. Later script output or a named shell step cannot
    # supply this identity. Never consult today's mutable refs/pull/N/merge.
    witnesses = [j for j in jobs['jobs'] if j['name'] == 'env-manager-fast-path' and j['conclusion'] == 'success']
    if len(witnesses) != 1:
        raise SystemExit('publication_legacy_execution_unresolved')
    job = witnesses[0]
    checkout = 'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955'
    steps = job.get('steps', [])
    if (str(job.get('run_id')) != run_id or str(job.get('run_attempt')) != attempt or len(steps) < 2
            or [(x.get('number'), x.get('name'), x.get('conclusion')) for x in steps[:2]] !=
               [(1, 'Set up job', 'success'), (2, 'Run ' + checkout, 'success')]):
        raise SystemExit('publication_legacy_execution_unresolved')
    logs = run(['gh', 'api', f'repos/{repo}/actions/jobs/{job["id"]}/logs']).decode('utf-8-sig')
    lines = [re.sub(r'^\d{4}-\d\d-\d\dT[0-9:.]+Z ', '', line) for line in logs.splitlines()]
    marker = 'Complete job name: env-manager-fast-path'
    if lines.count(marker) != 1:
        raise SystemExit('publication_legacy_execution_unresolved')
    start = lines.index(marker) + 1
    header = lines[start:]
    if not header or header[0] != '##[group]Run ' + checkout or '##[endgroup]' not in header:
        raise SystemExit('publication_legacy_execution_unresolved')
    end = header.index('##[endgroup]')
    inputs = header[1:end]
    # These are the actual runner inputs, before the action executes. A ref,
    # alternate server, shell, custom action env, or ambiguous input refuses.
    allowed = {'fetch-depth', 'repository', 'token', 'ssh-strict', 'ssh-user', 'persist-credentials',
               'clean', 'sparse-checkout-cone-mode', 'fetch-tags', 'show-progress', 'lfs',
               'submodules', 'set-safe-directory', 'IMAGE_NAME', 'FLEET_CONTROL_ENV'}
    values = {}
    for line in inputs:
        if line in ('with:', 'env:'):
            continue
        m = re.fullmatch(r'  ([A-Za-z_][A-Za-z0-9_-]*): (.*)', line)
        if not m or m[1] not in allowed or m[1] in values:
            raise SystemExit('publication_legacy_execution_unresolved')
        values[m[1]] = m[2]
    if values.get('repository') != repo or values.get('fetch-depth') != '0':
        raise SystemExit('publication_legacy_execution_unresolved')
    body = header[end + 1:]
    # Stop BEFORE the next user step or post action. The pinned first action
    # owns the single git log result, not an arbitrary match in whole-job text.
    boundary = next((i for i, line in enumerate(body) if line.startswith('##[group]Run ') or line == 'Post job cleanup.'), len(body))
    body = body[:boundary]
    positions = [i for i, line in enumerate(body) if line == '[command]/usr/bin/git log -1 --format=%H']
    if len(positions) != 1 or positions[0] + 1 >= len(body):
        raise SystemExit('publication_legacy_execution_unresolved')
    revision = body[positions[0] + 1]
    if not re.fullmatch('[a-f0-9]{40}', revision):
        raise SystemExit('publication_legacy_execution_unresolved')
    prs = original.get('pull_requests', [])
    if len(prs) != 1 or prs[0].get('head', {}).get('sha') != original.get('head_sha'):
        raise SystemExit('publication_legacy_execution_unresolved')
    commit = api(f'repos/{repo}/git/commits/{revision}')
    if (commit.get('sha') != revision or [p.get('sha') for p in commit.get('parents', [])] !=
            [prs[0].get('base', {}).get('sha'), original['head_sha']]):
        raise SystemExit('publication_legacy_execution_contradiction')
    return revision
def inspect(expression):
    return json.loads(run(['docker', 'buildx', 'imagetools', 'inspect', ref, '--format', expression]))
config = inspect('{{json .Image}}')
if config.get('os') != 'linux' or config.get('architecture') != 'amd64':
    raise SystemExit('publication_platform_mismatch')
labels = config.get('config', {}).get('Labels', {})
if labels.get('org.opencontainers.image.revision') != source_sha:
    raise SystemExit('publication_source_mismatch')
base = ['gh', 'attestation', 'verify', 'oci://' + ref, '--repo', repo,
        '--signer-workflow', repo + '/' + workflow, '--predicate-type', 'https://slsa.dev/provenance/v1',
        '--format', 'json', '--limit', '20']
errors = []
verified = None
for extra in ([], ['--bundle-from-oci'], *([['--bundle', retained]] if retained else [])):
    try:
        verified = json.loads(run(base + extra))
        if not isinstance(verified, list) or not verified or len(verified) > 20:
            raise RuntimeError('publication_native_result_invalid')
        break
    except (RuntimeError, ValueError) as e:
        errors.append(str(e))
if verified is None and not retained:
    # Recover an original signed bundle from the existing evidence home. This
    # projection is not trusted until native verification succeeds below.
    for page in range(1, 6):
        d = api(f'repos/{repo}/actions/artifacts?per_page=100&page={page}')
        for a in d['artifacts']:
            name = a['name']
            if a['expired'] or a['size_in_bytes'] > MAX or not (name == 'build-manifest-' + source_sha or
                    name.startswith(f'pr-build-fragment-{target}-{source_sha}-attempt-')):
                continue
            archive = zipfile.ZipFile(io.BytesIO(run(['gh', 'api', f'repos/{repo}/actions/artifacts/{a["id"]}/zip'])))
            if sum(x.file_size for x in archive.infolist()) > MAX:
                raise SystemExit('publication_bundle_bound')
            for name in archive.namelist():
                if not name.endswith('.json'):
                    continue
                payload = json.loads(archive.read(name))
                for entry in payload.get('targets', []):
                    if entry.get('target') != target or entry.get('digest') != ref:
                        continue
                    bundle = entry.get('publication', {}).get('bundle')
                    if not bundle:
                        continue
                    with tempfile.NamedTemporaryFile(suffix='.json', mode='w') as f:
                        json.dump(bundle, f); f.flush()
                        try:
                            verified = json.loads(run(base + ['--bundle', f.name]))
                        except (RuntimeError, ValueError) as e:
                            errors.append(str(e))
                    if verified:
                        break
        if verified or len(d['artifacts']) < 100:
            break
if verified is not None:
    matches = []
    for result in verified:
        try:
            v = result['verificationResult']
            cert = v['signature']['certificate']
            statement = v['statement']
            subjects = statement['subject']
            if len(subjects) != 1 or subjects[0]['name'] != image or subjects[0]['digest'] != {'sha256': digest[7:]}:
                raise RuntimeError('publication_native_subject_mismatch')
            signer = cert['buildSignerDigest']
            if not re.fullmatch('[a-f0-9]{40}', signer):
                raise RuntimeError('publication_signer_revision_invalid')
            uri = cert['buildSignerURI']
            if not uri.startswith(f'https://github.com/{repo}/{workflow}@'):
                raise RuntimeError('publication_signer_workflow_mismatch')
            p = statement['predicate']
            invocation = p['runDetails']['metadata']['invocationId']
            m = re.fullmatch(r'https://github.com/' + re.escape(repo) + r'/actions/runs/(\d+)/attempts/(\d+)', invocation)
            if not m:
                raise RuntimeError('publication_invocation_invalid')
            qualify_producer_closure(signer)
            # The operation authorizes a commit in its declared repository.
            # A trusted dispatched producer can check that SAME commit out of a
            # fork. Authenticate its actual checkout separately; GitHub's commit
            # API must prove that it is also the operation's authorized source.
            actual_repo = labels.get('io.cogni.publication.source', '')
            if not re.fullmatch(r'[\w.-]+/[\w.-]+', actual_repo):
                raise RuntimeError('publication_source_repository_invalid')
            if actual_repo != source_repo:
                # A PR/aggregate that names an actual foreign checkout is exact.
                # Only the uniform in-repo nodeRef can recover the operator's
                # authenticated foreign-dispatch publication of its own commit.
                if source_repo != repo:
                    raise RuntimeError('publication_source_repository_mismatch')
                original = api(f'repos/{repo}/actions/runs/{m[1]}/attempts/{m[2]}')
                if (original.get('event') != 'workflow_dispatch' or str(original.get('id')) != m[1]
                        or str(original.get('run_attempt')) != m[2]
                        or original.get('path', '').split('@')[0] != workflow):
                    raise RuntimeError('publication_foreign_dispatch_unproven')
                authorized = api(f'repos/{source_repo}/commits/{source_sha}')
                if authorized.get('sha') != source_sha:
                    raise RuntimeError('publication_source_not_authorized')
            expected = {'io.cogni.publication.version': '2', 'io.cogni.publication.source': actual_repo,
                        'io.cogni.publication.target': target, 'io.cogni.publication.platform': 'linux/amd64',
                        'io.cogni.publication.workflow-sha': signer, 'io.cogni.publication.run': m[1],
                        'io.cogni.publication.attempt': m[2]}
            if labels.get('org.opencontainers.image.source') != 'https://github.com/' + actual_repo:
                raise RuntimeError('publication_source_repository_mismatch')
            if any(labels.get(k) != val for k, val in expected.items()):
                raise RuntimeError('publication_checkout_binding_mismatch')
            recipe = run(['bash', '-c', '. "$1"; publication_recipe "$2" "$3" "$4"', 'recipe',
                          str(pathlib.Path(tooling, 'scripts/ci/lib/publication-proof.sh')), actual_repo, source_sha, target]).decode().strip()
            if labels.get('io.cogni.publication.recipe') != recipe:
                raise RuntimeError('publication_recipe_mismatch')
            matches.append({'kind': 'native-v2', 'source_repository': actual_repo, 'source_sha': source_sha,
                            'target': target, 'platform': 'linux/amd64', 'recipe': recipe,
                            'producer': {'repository': repo, 'workflow': workflow, 'revision': signer,
                                         'run_id': m[1], 'run_attempt': m[2]},
                            'bundle': result['attestation']['bundle']})
        except (KeyError, RuntimeError, ValueError) as e:
            errors.append(str(e))
    if not matches or any({k:v for k,v in x.items() if k != 'bundle'} != {k:v for k,v in matches[0].items() if k != 'bundle'} for x in matches):
        raise SystemExit('publication_unverified: ' + '; '.join(errors))
    evidence = matches[0]
else:
    # Explicit legacy-v1: authenticate an actual legacy definition, source
    # checkout and successful producing run. Missing v2 fields NEVER select it.
    # Corrected images with lost proof refuse here even if an old manifest exists.
    if labels.get('io.cogni.publication.version') is not None:
        raise SystemExit('publication_unverified: native evidence unavailable: ' + '; '.join(errors))
    evidence = None
    for page in range(1, 6):
        d = api(f'repos/{repo}/actions/artifacts?name=build-manifest-{source_sha}&per_page=100&page={page}')
        artifacts = d['artifacts']
        for a in artifacts:
            if a['expired'] or a['name'] != 'build-manifest-' + source_sha or a['size_in_bytes'] > MAX:
                continue
            run_id = str(a['workflow_run']['id'])
            r = api(f'repos/{repo}/actions/runs/{run_id}')
            if r['path'].split('@')[0] != workflow:
                continue
            archive = run(['gh', 'api', f'repos/{repo}/actions/artifacts/{a["id"]}/zip'])
            z = zipfile.ZipFile(io.BytesIO(archive))
            if sum(x.file_size for x in z.infolist()) > MAX or z.namelist() != ['build-manifest.json']:
                raise SystemExit('publication_legacy_artifact_invalid')
            manifest = json.loads(z.read('build-manifest.json'))
            attempt = str(manifest.get('workflow', {}).get('run_attempt', ''))
            if not re.fullmatch(r'[1-9][0-9]*', attempt):
                raise SystemExit('publication_legacy_run_mismatch')
            original = api(f'repos/{repo}/actions/runs/{run_id}/attempts/{attempt}')
            if (original.get('conclusion') != 'success' or original.get('path', '').split('@')[0] != workflow
                    or original.get('head_sha') != r['head_sha'] or str(original.get('id')) != run_id):
                raise SystemExit('publication_legacy_run_mismatch')
            if (manifest.get('schema_version') != 1 or manifest.get('repository') != repo
                    or manifest.get('head_sha') != source_sha or manifest.get('platform') != 'linux/amd64'
                    or str(manifest.get('workflow', {}).get('run_id')) != run_id
                    or str(original.get('run_attempt')) != attempt):
                raise SystemExit('publication_legacy_run_mismatch')
            jobs = api(f'repos/{repo}/actions/runs/{run_id}/attempts/{attempt}/jobs?per_page=100')
            if jobs['total_count'] > 100:
                raise SystemExit('publication_legacy_job_bound')
            workflow_revision = legacy_workflow_revision(original, jobs, run_id, attempt)
            # Legacy workflow executes at its own native run identity; builder,
            # sourced helper and unsigned aggregation execute at app checkout.
            # Check each file where it actually ran, never require app helpers
            # at a possibly different workflow revision (or vice versa).
            for path, trusted in legacy_blobs.items():
                owner, revision = (repo, workflow_revision) if path == workflow else (source_repo, source_sha)
                if git_blob(remote_blob(owner, revision, path)) != trusted:
                    raise SystemExit('publication_legacy_definition_mismatch')
            entries = [x for x in manifest['targets'] if x['target'] == target]
            catalog = remote_blob(source_repo, source_sha, f'infra/catalog/{target}.yaml')
            declaration = json.loads(subprocess.check_output(['yq', '-o=json', '.'], input=catalog, timeout=20))
            expected_tag = image + ':sha-' + source_sha + (declaration.get('image_tag_suffix') or '')
            if len(entries) != 1 or entries[0]['digest'] != ref or entries[0]['tag'] != expected_tag:
                raise SystemExit('publication_legacy_subject_mismatch')
            producers = [j for j in jobs['jobs'] if j['name'] == f'build ({target})' and j['conclusion'] == 'success']
            if len(producers) != 1:
                raise SystemExit('publication_legacy_producer_ambiguous')
            aggregators = [j for j in jobs['jobs'] if j['name'] == 'manifest' and j['conclusion'] == 'success']
            if len(aggregators) != 1:
                raise SystemExit('publication_legacy_checkout_unproven: manifest job')
            # Both application checkouts must execute the exact qualified S
            # helpers. Authentic W alone cannot make arbitrary Q shell trusted.
            legacy_app_checkout(producers[0], run_id, attempt)
            legacy_app_checkout(aggregators[0], run_id, attempt)
            evidence = {'kind': 'legacy-v1', 'source_repository': source_repo, 'source_sha': source_sha,
                        'target': target, 'platform': 'linux/amd64', 'artifact_id': a['id'],
                        'producer': {'repository': repo, 'workflow': workflow, 'revision': workflow_revision,
                                     'run_id': run_id, 'run_attempt': attempt}}
            break
        if evidence or len(artifacts) < 100:
            break
    if evidence is None:
        raise SystemExit('publication_unverified: no authentic native or legacy publication')
# Keep available BuildKit input evidence with the selected artifact. Failure to
# read existing OCI metadata is unresolved, never permission to rebuild.
evidence['buildkit'] = inspect('{{json .Provenance}}')
pathlib.Path(output).write_text(json.dumps(evidence, sort_keys=True) + '\n')
PY
}

# Used by detect under trusted workflow tooling. Aliases that publish the same
# physical tag share a group, including content-hash infra tags across sources.
publication_matrix() {
  local targets="$1" target tag rows='[]'
  while IFS= read -r target; do
    if is_infra_target "$target"; then
      tag=$(infra_image_tag "$target")
    else
      tag=$(image_tag_for_target "$(image_name_for_target "$target")" "$IMAGE_TAG" "$target")
    fi
    rows=$(jq --arg target "$target" --arg coordinate "$tag-linux/amd64" \
      '. + [{target:$target,publication_coordinate:$coordinate}]' <<< "$rows")
  done < <(jq -r '.[]' <<< "$targets")
  printf '%s\n' "$rows" | jq -c .
}
