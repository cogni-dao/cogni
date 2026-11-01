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
  local tag="$1" result err rc=0
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
  if [[ "$rc" != 0 ]] && grep -Eqi 'manifest unknown|MANIFEST_UNKNOWN|not found' "$err" &&
      ! grep -Eqi 'unauthorized|denied|forbidden|timeout|connection|5[0-9][0-9]' "$err"; then
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
def same_tooling(revision):
    # Authenticate the signer IMPLEMENTATION, not an app-provided schema marker.
    # Historical corrected publications use the same reviewed producer bytes.
    for path in (workflow, 'scripts/ci/build-and-push-images.sh', 'scripts/ci/lib/publication-proof.sh'):
        if remote_blob(repo, revision, path) != pathlib.Path(tooling, path).read_bytes():
            raise RuntimeError('publication_signer_implementation_mismatch')
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
            same_tooling(signer)
            expected = {'io.cogni.publication.version': '2', 'io.cogni.publication.source': source_repo,
                        'io.cogni.publication.target': target, 'io.cogni.publication.platform': 'linux/amd64',
                        'io.cogni.publication.workflow-sha': signer, 'io.cogni.publication.run': m[1],
                        'io.cogni.publication.attempt': m[2]}
            if labels.get('org.opencontainers.image.source') != 'https://github.com/' + source_repo:
                raise RuntimeError('publication_source_repository_mismatch')
            if any(labels.get(k) != val for k, val in expected.items()):
                raise RuntimeError('publication_checkout_binding_mismatch')
            recipe = run(['bash', '-c', '. "$1"; publication_recipe "$2" "$3" "$4"', 'recipe',
                          str(pathlib.Path(tooling, 'scripts/ci/lib/publication-proof.sh')), source_repo, source_sha, target]).decode().strip()
            if labels.get('io.cogni.publication.recipe') != recipe:
                raise RuntimeError('publication_recipe_mismatch')
            matches.append({'kind': 'native-v2', 'source_repository': source_repo, 'source_sha': source_sha,
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
            if r['path'].split('@')[0] != workflow or r['conclusion'] != 'success':
                continue
            # Exact known legacy implementation. Both workflow and executed app
            # helper must match it; foreign checkout cannot supply its own proof.
            for path, trusted in legacy_blobs.items():
                if (api(f'repos/{repo}/contents/{path}?ref={r["head_sha"]}')['sha'] != trusted or
                        api(f'repos/{source_repo}/contents/{path}?ref={source_sha}')['sha'] != trusted):
                    raise SystemExit('publication_legacy_definition_mismatch')
            archive = run(['gh', 'api', f'repos/{repo}/actions/artifacts/{a["id"]}/zip'])
            z = zipfile.ZipFile(io.BytesIO(archive))
            if sum(x.file_size for x in z.infolist()) > MAX or z.namelist() != ['build-manifest.json']:
                raise SystemExit('publication_legacy_artifact_invalid')
            manifest = json.loads(z.read('build-manifest.json'))
            if (manifest.get('schema_version') != 1 or manifest.get('repository') != repo
                    or manifest.get('head_sha') != source_sha or manifest.get('platform') != 'linux/amd64'
                    or str(manifest.get('workflow', {}).get('run_id')) != run_id
                    or str(manifest.get('workflow', {}).get('run_attempt')) != str(r['run_attempt'])):
                raise SystemExit('publication_legacy_run_mismatch')
            entries = [x for x in manifest['targets'] if x['target'] == target]
            catalog = remote_blob(source_repo, source_sha, f'infra/catalog/{target}.yaml')
            declaration = json.loads(subprocess.check_output(['yq', '-o=json', '.'], input=catalog, timeout=20))
            expected_tag = image + ':sha-' + source_sha + (declaration.get('image_tag_suffix') or '')
            if len(entries) != 1 or entries[0]['digest'] != ref or entries[0]['tag'] != expected_tag:
                raise SystemExit('publication_legacy_subject_mismatch')
            jobs = api(f'repos/{repo}/actions/runs/{run_id}/attempts/{r["run_attempt"]}/jobs?per_page=100')
            if jobs['total_count'] > 100:
                raise SystemExit('publication_legacy_job_bound')
            producers = [j for j in jobs['jobs'] if j['name'] == f'build ({target})' and j['conclusion'] == 'success']
            if len(producers) != 1:
                raise SystemExit('publication_legacy_producer_ambiguous')
            logs = run(['gh', 'api', f'repos/{repo}/actions/jobs/{producers[0]["id"]}/logs']).decode(errors='replace')
            if not re.search(r'repository: [\s\x1b\[0-9;m]*' + re.escape(source_repo) + r'\s', logs) or not re.search(r'ref: ' + source_sha + r'\s', logs):
                raise SystemExit('publication_legacy_checkout_unproven')
            evidence = {'kind': 'legacy-v1', 'source_repository': source_repo, 'source_sha': source_sha,
                        'target': target, 'platform': 'linux/amd64', 'artifact_id': a['id'],
                        'producer': {'repository': repo, 'workflow': workflow, 'revision': r['head_sha'],
                                     'run_id': run_id, 'run_attempt': str(r['run_attempt'])}}
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
