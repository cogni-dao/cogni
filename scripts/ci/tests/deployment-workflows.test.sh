#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/candidate-flight.yml"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Execute the real workflow steps against affected-set fixtures. No copied
# selection implementation and no GitHub, provider, or cluster calls.
yq -r '.jobs.decide.steps[] | select(.id == "flight-targets") | .run' "$WORKFLOW" > "$work/combine.sh"
check_scope() {
  local name="$1" node="$2" pr="$3" affected="$4" has_parent="$5" expected="$6" images="$7"
  local output="$work/$name.out"
  NODE_SLUG="$node" RESOLVED_PR_NUMBER="$pr" \
    NORMAL_FLIGHT_TARGETS_JSON="$affected" HAS_PARENT_TARGETS="$has_parent" \
    REMOTE_SOURCE_ARTIFACT_TARGETS_JSON='[]' HAS_REMOTE_SOURCE_ARTIFACT_TARGETS=false \
    BASE_SHA='' GITHUB_OUTPUT="$output" bash "$work/combine.sh"
  local actual
  actual=$(sed -n 's/^flight_targets_json=//p' "$output" | jq -c .)
  [[ "$actual" == "$expected" ]] || { echo "[FAIL] $name targets: $actual"; exit 1; }
  grep -qx "has_image_inputs=$images" "$output"
  if [[ "$expected" == '[]' ]]; then
    grep -qx 'has_flight_targets=false' "$output"
  else
    grep -qx 'has_flight_targets=true' "$output"
  fi
  echo "[PASS] $name"
}

check_scope ci-only operator 2780 '[]' false '[]' false
check_scope infra-only operator 2780 '[]' true '[]' true
check_scope app-change operator 2780 '["operator"]' true '["operator"]' true
check_scope other-app operator 2780 '["poly"]' true '["poly"]' true
check_scope standalone-node poly '' '[]' false '["poly"]' true

# Real app targets still fail closed when their requested image is absent.
yq -r '.jobs.decide.steps[] | select(.name == "Require requested node image") | .run' "$WORKFLOW" > "$work/require-image.sh"
printf '{"targets":[{"target":"litellm"}]}\n' > "$work/images.json"
if NODE=operator PAYLOAD_FILE="$work/images.json" bash "$work/require-image.sh" > "$work/missing.log" 2>&1; then
  echo '[FAIL] missing requested app image was accepted'
  exit 1
fi
grep -q 'Requested node image is not available yet: operator' "$work/missing.log"
printf '{"targets":[{"target":"operator"}]}\n' > "$work/images.json"
NODE=operator PAYLOAD_FILE="$work/images.json" bash "$work/require-image.sh"
echo '[PASS] requested app image remains mandatory for an affected app'

# Production's exact explicit source must reach the pin writer, while an
# incidental catalog selection must keep its existing rollback fence.
promote="$REPO_ROOT/.github/workflows/promote-and-deploy.yml"
yq -r '.jobs.promote-k8s.steps[] | select(.name == "Record external workload source-sha") | .run' "$promote" > "$work/pin.sh"
mkdir -p "$work/ci-src/scripts/ci" "$work/app-src/infra/catalog" "$work/deploy-branch/.promote-state"
ln -s "$REPO_ROOT/scripts/ci/update-source-sha-map.sh" "$work/ci-src/scripts/ci/update-source-sha-map.sh"
birth=1111111111111111111111111111111111111111
prior=2222222222222222222222222222222222222222
printf 'source_sha: %s\n' "$birth" > "$work/app-src/infra/catalog/poly.yaml"
for explicit in '' 3333333333333333333333333333333333333333 "$birth"; do
  printf '{"poly":"%s","operator":"retained"}\n' "$prior" > "$work/deploy-branch/.promote-state/source-sha-by-app.json"
  result=0
  (cd "$work/deploy-branch"; APP=poly NODE=poly SOURCE_SHA="$birth" NODE_SOURCE_SHA="$explicit" bash "$work/pin.sh") > "$work/pin.log" 2>&1 || result=$?
  if [[ "$explicit" == "$birth" ]]; then
    [[ "$result" == 0 ]] || { cat "$work/pin.log"; exit 1; }
    jq -e --arg sha "$birth" '.poly == $sha and .operator == "retained"' "$work/deploy-branch/.promote-state/source-sha-by-app.json" >/dev/null
  else
    [[ "$result" != 0 ]] || { echo '[FAIL] implicit birth regression accepted'; exit 1; }
    grep -q PIN_REGRESSION_REFUSED "$work/pin.log"
    jq -e --arg sha "$prior" '.poly == $sha' "$work/deploy-branch/.promote-state/source-sha-by-app.json" >/dev/null
  fi
done
echo '[PASS] only exact source-addressed promotions may deliberately select birth metadata'

# Preview must recognize a CI-only affected set before probing globally cached
# infra images, and report the no-op without asserting that a deploy happened.
preview="$REPO_ROOT/.github/workflows/flight-preview.yml"
yq -r '.jobs.flight.steps[] | select(.name == "Detect affected artifact inputs") | .run' "$preview" > "$work/preview-scope.sh"
printf 'scripts/ci/aggregate-rollup.sh\n.github/workflows/candidate-flight.yml\n' > "$work/paths.txt"
CHANGED_PATHS_FILE="$work/paths.txt" GITHUB_OUTPUT="$work/preview-scope.out" bash "$work/preview-scope.sh" > "$work/preview-scope.log"
grep -qx 'has_targets=false' "$work/preview-scope.out"
yq -r '.jobs.flight.steps[] | select(.id == "noop") | .run' "$preview" > "$work/noop.sh"
GITHUB_OUTPUT="$work/noop.out" GITHUB_STEP_SUMMARY="$work/noop-summary.md" bash "$work/noop.sh"
grep -qx 'status=noop' "$work/noop.out"
grep -q 'nothing deployed' "$work/noop-summary.md"
echo '[PASS] CI-only preview scope is an explicit no-op'

# The selected preview or target branch must be present before the shared writer reads it.
prepare_line=$(grep -n 'name: Prepare per-node deploy branch' "$promote" | cut -d: -f1)
materialize_line=$(grep -n 'name: Materialize provider-neutral external workload' "$promote" | cut -d: -f1)
sync_line=$(grep -n 'name: Sync infra/k8s + per-node catalog' "$promote" | cut -d: -f1)
[[ "$prepare_line" -lt "$materialize_line" && "$materialize_line" -lt "$sync_line" ]]
destination=$(yq -r '.jobs.promote-k8s.steps[] | select(.name == "Materialize provider-neutral external workload") | .with.destination_accepted_overlay_dir' "$promote")
preview_overlay=$(yq -r '.jobs.promote-k8s.steps[] | select(.name == "Materialize provider-neutral external workload") | .with.preview_overlay_dir' "$promote")
preview_mode=$(yq -r '.jobs.promote-k8s.steps[] | select(.name == "Materialize provider-neutral external workload") | .with.preview_forward' "$promote")
[[ "$destination" == '${{ github.workspace }}/deploy-branch/infra/k8s/overlays/${{ needs.decide.outputs.environment }}/${{ matrix.node }}' ]]
[[ "$preview_overlay" == '${{ github.workspace }}/preview-src/infra/k8s/overlays/preview/${{ matrix.node }}' ]]
[[ "$preview_mode" == '${{ fromJSON(needs.decide.outputs.preview_forward_by_target_json)[matrix.node] }}' ]]
action="$REPO_ROOT/.github/actions/materialize-compute-workload/action.yml"
[[ $(yq -r '.runs.steps[] | select(.name == "Materialize immutable desired state") | .env.DESTINATION_ACCEPTED_OVERLAY_DIR // ""' "$action") == '${{ inputs.destination_accepted_overlay_dir }}' ]]
[[ $(yq -r '.runs.steps[] | select(.name == "Materialize immutable desired state") | .env.PREVIEW_OVERLAY_DIR // ""' "$action") == '${{ inputs.preview_overlay_dir }}' ]]
[[ $(yq -r '.runs.steps[] | select(.name == "Materialize immutable desired state") | .env.PREVIEW_FORWARD // ""' "$action") == '${{ inputs.preview_forward }}' ]]
# Candidate's existing shared action invocation must stay valid without optional paths.
yq -e '.jobs | .. | select(tag == "!!map" and has("uses")) | select(.uses | contains("materialize-compute-workload")) | .with | has("destination_accepted_overlay_dir") | not' "$WORKFLOW" >/dev/null
yq -e '.jobs | .. | select(tag == "!!map" and has("uses")) | select(.uses | contains("materialize-compute-workload")) | .with | has("preview_overlay_dir") | not' "$WORKFLOW" >/dev/null
echo '[PASS] replay reads the selected deploy overlay before syncing; candidate needs no new input'

# Run the actual digest step with a missing app tag. Akash must not inspect it;
# the explicitly requested k3s target must still fail its image lookup.
yq -r '.jobs.promote-k8s.steps[] | select(.id == "digest") | .run' "$promote" > "$work/digest.sh"
mkdir -p "$work/app-src/scripts/ci/lib" "$work/ci-src/scripts/ci/lib" "$work/bin"
ln -s "$REPO_ROOT/scripts/ci/lib/maintenance-fence.py" "$work/ci-src/scripts/ci/lib/maintenance-fence.py"
for helper in image-tags publication-proof overlay-digest; do
  ln -s "$REPO_ROOT/scripts/ci/lib/$helper.sh" "$work/ci-src/scripts/ci/lib/$helper.sh"
done
ln -s "$REPO_ROOT/scripts/ci/lib/image-tags.sh" "$work/app-src/scripts/ci/lib/image-tags.sh"
cat > "$work/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$DOCKER_CALLS"
exit 1
DOCKER
chmod +x "$work/bin/docker"
for provider in akash k3s; do
  result=0
  (cd "$work"; PATH="$work/bin:$PATH" DOCKER_CALLS="$work/docker.calls" \
    COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" NODE=operator \
    DEPLOYMENT_PROVIDER="$provider" PREVIEW_FORWARD=false BUILD_SHA="$birth" \
    DESTINATION_ESTABLISHED=false PRESERVE_APP=false SOURCE_REPOSITORY=cogni-dao/cogni \
    NODE_SOURCE_SHA='' OPERATOR_SOURCE_SHA="$birth" CATALOG_SOURCE_SHA='' \
    PREVIEW_SOURCE_SHA_MAP='' EXPLICIT_TARGETS=operator GITHUB_OUTPUT="$work/$provider.out" \
    bash "$work/digest.sh") > "$work/$provider.log" 2>&1 || result=$?
  if [[ "$provider" == akash ]]; then
    [[ "$result" == 0 && ! -e "$work/docker.calls" ]] || { cat "$work/$provider.log"; exit 1; }
    grep -qx 'promoted=true' "$work/$provider.out"
  else
    [[ "$result" != 0 && -s "$work/docker.calls" ]] || { cat "$work/$provider.log"; exit 1; }
    grep -q 'Image not found' "$work/$provider.log"
  fi
done
echo '[PASS] Akash skips unused app tag; k3s requires its image'

# subtask.5031: execute the actual selection -> sync -> image/map writer order.
# The expected source/digests come from actual historical manifests, not from a
# second selection algorithm. Native GitHub signature/concurrency proof remains
# an independent remote gate; these tests do not claim to implement either.
fixtures="$REPO_ROOT/scripts/ci/tests/fixtures/artifact-publication"
mq="$fixtures/mq-41163851879.json"
push="$fixtures/push-41164935499.json"
manual="$fixtures/manual-41166218224.json"
accepted_source=$(jq -r .head_sha "$mq")
accepted_ref=$(jq -r '.targets[] | select(.target == "operator") | .digest' "$mq")
replaced_ref=$(jq -r '.targets[] | select(.target == "operator") | .digest' "$push")
new_source=$(jq -r .head_sha "$manual")
[[ "$accepted_source" == "$(jq -r .head_sha "$push")" && "$accepted_ref" != "$replaced_ref" ]]
[[ "$new_source" != "$accepted_source" ]]
lab="$work/preservation"
mkdir -p "$lab/app-src/infra/k8s/overlays/production" "$lab/app-src/infra/catalog" "$lab/bin"
ln -s "$REPO_ROOT" "$lab/ci-src"
cp -R "$REPO_ROOT/infra/k8s/base" "$lab/app-src/infra/k8s/"
cp -R "$REPO_ROOT/infra/k8s/overlays/production/operator" "$lab/app-src/infra/k8s/overlays/production/"
cp "$REPO_ROOT/infra/catalog/operator.yaml" "$lab/app-src/infra/catalog/"
cp -R "$lab/app-src" "$lab/deploy-branch"
mkdir -p "$lab/deploy-branch/.promote-state"
# Permitted config is intentionally newer than the accepted app image.
yq -i '.commonAnnotations.artifactFixture = "converged"' "$lab/app-src/infra/k8s/overlays/production/operator/kustomization.yaml"
yq -i 'del(.images[0].newTag)' "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml"
ACCEPTED_DIGEST="${accepted_ref##*@}" yq -i '.images[0].digest = strenv(ACCEPTED_DIGEST)' "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml"
printf '{"operator":"%s"}\n' "$accepted_source" > "$lab/deploy-branch/.promote-state/source-sha-by-app.json"
cat > "$lab/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
echo "$*" >> "$DOCKER_CALLS"
echo 'unexpected registry access; the tag now points to AD1' >&2
exit 1
DOCKER
chmod +x "$lab/bin/docker"
yq -r '.jobs.promote-k8s.steps[] | select(.name == "Sync infra/k8s + per-node catalog from app-src") | .run' "$promote" > "$lab/sync.sh"
yq -r '.jobs.promote-k8s.steps[] | select(.name == "Promote digest + record source-sha") | .run' "$promote" > "$lab/write.sh"
select_fixture() {
  (cd "$lab"; PATH="$lab/bin:$PATH" DOCKER_CALLS="$lab/docker.calls" \
    GITHUB_REPOSITORY=cogni-dao/cogni SOURCE_REPOSITORY=cogni-dao/cogni \
    COGNI_CATALOG_ROOT="$lab/app-src/infra/catalog" NODE=operator \
    DEPLOYMENT_PROVIDER=k3s PREVIEW_FORWARD=false PRESERVE_APP=true DESTINATION_ESTABLISHED=true \
    BUILD_SHA="$accepted_source" NODE_SOURCE_SHA='' OPERATOR_SOURCE_SHA="$accepted_source" \
    CATALOG_SOURCE_SHA='' PREVIEW_SOURCE_SHA_MAP='' OVERLAY_ENV=production EXPLICIT_TARGETS=operator \
    GITHUB_OUTPUT="$lab/selection.out" bash "$work/digest.sh")
}
select_fixture > "$lab/selection.log"
grep -qx "digest=$accepted_ref" "$lab/selection.out"
[[ ! -e "$lab/docker.calls" ]]
(cd "$lab"; GITHUB_WORKSPACE="$lab" NODE=operator OVERLAY_ENV=production DEPLOYMENT_PROVIDER=k3s bash "$lab/sync.sh")
(cd "$lab/deploy-branch"; NODE=operator OVERLAY_ENV=production DIGEST="$accepted_ref" SOURCE_SHA="$accepted_source" bash "$lab/write.sh")
[[ $(yq -r '.commonAnnotations.artifactFixture' "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml") == converged ]]
[[ $(yq -r '.images[0].digest' "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml") == "${accepted_ref##*@}" ]]
for role in akash-tx-actuator lease-log-pump database-reliability-actuator; do
  yq -e --expression ".resources[] | select(contains(\"$role\"))" "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml" >/dev/null
  # The actual shared roles use the app image's logical Kustomize mapping.
  grep -q 'image: ghcr.io/cogni-dao/cogni-template' "$lab/deploy-branch/infra/k8s/base/$role/deployment.yaml"
done
grep -q 'image: ghcr.io/cogni-dao/cogni-template' "$lab/deploy-branch/infra/k8s/base/node-app/deployment.yaml"
echo '[PASS] actual E728 acceptance wins over same-source AD1 tag; config and shared-role resources converge'

# Capture A, install B, then allow the queued infra selection to execute. Hash
# every destination file to catch writes before the final image/map writer too.
printf '{"operator":"%s"}\n' "$new_source" > "$lab/deploy-branch/.promote-state/source-sha-by-app.json"
tree_snapshot() { (cd "$lab/deploy-branch"; find . -type f -exec sha256sum {} + | sort); }
tree_snapshot > "$lab/before"
if select_fixture > "$lab/stale.log" 2>&1 && \
    (cd "$lab"; GITHUB_WORKSPACE="$lab" NODE=operator OVERLAY_ENV=production DEPLOYMENT_PROVIDER=k3s bash "$lab/sync.sh"); then
  echo '[FAIL] captured infra A advanced accepted B'; exit 1
fi
grep -q stale_infra_source "$lab/stale.log"
tree_snapshot > "$lab/after"
cmp "$lab/before" "$lab/after"
[[ ! -e "$lab/docker.calls" ]]
echo '[PASS] queued stale infra refuses before all sync/shared-role/image/map writes'

# Established malformed/ambiguous acceptance must not become an initial lane.
printf '{"operator":"%s"}\n' "$accepted_source" > "$lab/deploy-branch/.promote-state/source-sha-by-app.json"
cp "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml" "$lab/good-overlay.yaml"
for defect in duplicate wrong-repository short-digest; do
  cp "$lab/good-overlay.yaml" "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml"
  case "$defect" in
    duplicate) yq -i '.images += [.images[0]]' "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml" ;;
    wrong-repository) yq -i '.images[0].newName="ghcr.io/other/app"' "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml" ;;
    short-digest) yq -i '.images[0].digest="sha256:abc"' "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml" ;;
  esac
  if select_fixture > "$lab/$defect.log" 2>&1; then echo "[FAIL] accepted $defect"; exit 1; fi
done
cp "$lab/good-overlay.yaml" "$lab/deploy-branch/infra/k8s/overlays/production/operator/kustomization.yaml"
echo '[PASS] malformed established lanes never fall through to tag discovery'

# Actual producer, native adapter and reader flows with process-level Docker/gh
# stubs. Only the external clients are replaced. There is no signing algorithm,
# mock deployment controller or copied publication/selection implementation.
pub="$work/publication"
mkdir -p "$pub/bin"
cat > "$pub/bin/client.py" <<'PY'
#!/usr/bin/env python3
import base64, io, json, os, pathlib, re, subprocess, sys, zipfile
root = pathlib.Path(os.environ['FIXTURE_ROOT'])
state = pathlib.Path(os.environ['FIXTURE_STATE'])
args = sys.argv[1:]
client = pathlib.Path(sys.argv[0]).name
with open(state / 'calls', 'a') as f: f.write(client + ' ' + ' '.join(args) + '\n')
def emit(value): print(json.dumps(value))
def fail(message): print(message, file=sys.stderr); raise SystemExit(1)
def config(): return json.loads((state / 'config.json').read_text())
def archive(payload, name):
    b = io.BytesIO()
    with zipfile.ZipFile(b, 'w') as z: z.writestr(name, json.dumps(payload))
    sys.stdout.buffer.write(b.getvalue())
if client == 'curl':
    assert sys.stdin.read().startswith('header = "Authorization: ')
    output = pathlib.Path(args[args.index('--output')+1])
    if '/token?' in args[-1]:
        output.write_text(json.dumps({'token':'fixture-authenticated-pull'})); print('200',end='')
    else:
        output.write_text(json.dumps({'errors':[{'code':'MANIFEST_UNKNOWN'}]})); print('404',end='')
    sys.exit(0)
if client == 'docker':
    if args[:2] == ['buildx', 'version']: print('fixture-buildx'); sys.exit(0)
    if args[0] == 'login': sys.exit(0)
    if args[:2] == ['buildx', 'build']:
        labels = {}
        for i, a in enumerate(args):
            if a == '--label':
                k, v = args[i+1].split('=', 1); labels[k] = v
        assert '--push' in args and '--provenance=mode=max' in args
        assert any(x.startswith('SOURCE_DATE_EPOCH=') for x in args)
        (state / 'config.json').write_text(json.dumps({'os':'linux', 'architecture':'amd64', 'config':{'Labels':labels}}))
        pathlib.Path(args[args.index('--metadata-file')+1]).write_text(json.dumps({'containerimage.digest':os.environ['FIXTURE_DIGEST']}))
        (state / 'present').touch()
        if os.environ.get('LOST_PUSH') == '1': fail('lost push response')
        sys.exit(0)
    if args[:3] == ['buildx', 'imagetools', 'inspect']:
        subject = args[3]
        if os.environ.get('LOOKUP_ERROR'): fail(os.environ['LOOKUP_ERROR'])
        if not (state / 'present').exists(): fail('manifest unknown')
        # Only the selected operator coordinate is present, never unrelated apps.
        if ':sha-' in subject and subject.rsplit(':sha-',1)[1] != os.environ['FIXTURE_SOURCE']:
            fail('manifest unknown')
        expression = args[-1]
        if expression == '{{json .Manifest.Digest}}': emit(os.environ['FIXTURE_DIGEST']); sys.exit(0)
        if expression == '{{json .Image}}':
            c = config(); labels = c['config']['Labels']; defect = os.environ.get('DEFECT')
            if defect == 'source': labels['org.opencontainers.image.revision'] = 'f'*40
            if defect == 'target': labels['io.cogni.publication.target'] = 'foreign'
            if defect == 'recipe': labels['io.cogni.publication.recipe'] = 'bad'
            if defect == 'platform': c['architecture'] = 'arm64'
            if defect == 'missing-fields': labels.pop('io.cogni.publication.version', None)
            emit(c); sys.exit(0)
        if expression == '{{json .Provenance}}': emit({'SLSA':{'fixture':'resolved-inputs'}}); sys.exit(0)
    fail('unexpected docker call')
if args[:2] == ['attestation', 'verify']:
    if '--help' in args:
        print('--signer-workflow --predicate-type --format --limit --bundle --bundle-from-oci'); sys.exit(0)
    mode = os.environ.get('NATIVE_MODE', 'api')
    assert '--repo' in args and args[args.index('--repo')+1] == 'cogni-dao/cogni'
    assert '--signer-workflow' in args and args[args.index('--signer-workflow')+1] == 'cogni-dao/cogni/.github/workflows/pr-build.yml'
    if mode == 'none': fail('no native attestations')
    if mode == 'oci' and '--bundle-from-oci' not in args: fail('API unavailable')
    if mode == 'retained':
        if '--bundle' not in args: fail('native attachment unavailable')
        assert json.load(open(args[args.index('--bundle')+1])) == {'fixture':'original-signed-bundle'}
    labels = config()['config']['Labels']
    sha = labels['io.cogni.publication.workflow-sha']
    invocation = 'https://github.com/cogni-dao/cogni/actions/runs/' + labels['io.cogni.publication.run'] + '/attempts/' + labels['io.cogni.publication.attempt']
    subject = {'name':'ghcr.io/cogni-dao/cogni-template', 'digest':{'sha256':os.environ['FIXTURE_DIGEST'][7:]}}
    defect = os.environ.get('DEFECT')
    if defect == 'subject': subject['digest']['sha256'] = 'b'*64
    if defect == 'signer': sha = 'e'*40
    cert = {'buildSignerDigest':sha, 'buildSignerURI':'https://github.com/cogni-dao/cogni/.github/workflows/pr-build.yml@refs/heads/main'}
    emit([{'attestation':{'bundle':{'fixture':'original-signed-bundle'}}, 'verificationResult':{'signature':{'certificate':cert}, 'statement':{'subject':[subject], 'predicate':{'runDetails':{'metadata':{'invocationId':invocation}}}}}}]); sys.exit(0)
if args[0] != 'api': fail('unexpected gh call')
endpoint = args[1]
if '/contents/' in endpoint:
    path = endpoint.split('/contents/',1)[1].split('?',1)[0]
    legacy = os.environ.get('LEGACY') == '1'
    legacy_blobs = {'.github/workflows/pr-build.yml':'6f43c32fbaf414f3c2919a4c0448cb83a75cacd0', 'scripts/ci/build-and-push-images.sh':'f52e1cd23a4758dbff2cd78ee0741113cf3761ba', 'scripts/ci/write-build-manifest.sh':'02da0177a038bdad230d33b850281890e21fb4d1'}
    data = (root / path).read_bytes()
    if os.environ.get('DEFECT') == 'signer' and '.github/workflows' in path: data = b'foreign workflow'
    blob = legacy_blobs.get(path, '') if legacy else 'corrected-producer-blob'
    if os.environ.get('DEFECT') == 'missing-fields': blob = 'corrected-producer-blob'
    emit({'sha':blob, 'content':base64.b64encode(data).decode()}); sys.exit(0)
if '/actions/artifacts' in endpoint:
    if endpoint.endswith('/zip'):
        if os.environ.get('LEGACY') == '1':
            archive(json.load(open(os.environ['LEGACY_MANIFEST'])), 'build-manifest.json')
        else: archive(json.load(open(state / 'retained.json')), 'build-manifest.json')
        sys.exit(0)
    if os.environ.get('LEGACY') == '1' or os.environ.get('NATIVE_MODE') == 'retained':
        emit({'artifacts':[{'id':42, 'name':'build-manifest-' + os.environ['FIXTURE_SOURCE'], 'size_in_bytes':2048, 'expired':False, 'workflow_run':{'id':41163851879}}]})
    else: emit({'artifacts':[]})
    sys.exit(0)
if '/actions/runs/' in endpoint:
    if '/jobs?' in endpoint: emit({'total_count':1,'jobs':[{'id':43,'name':'build (operator)','conclusion':'success'}]})
    else: emit({'path':'.github/workflows/pr-build.yml','conclusion':'success','head_sha':os.environ['FIXTURE_SOURCE'],'run_attempt':1})
    sys.exit(0)
if '/actions/jobs/' in endpoint:
    print('repository: cogni-dao/cogni\nref: ' + os.environ['FIXTURE_SOURCE'] + '\n'); sys.exit(0)
fail('unexpected gh endpoint ' + endpoint)
PY
chmod +x "$pub/bin/client.py"
ln -s client.py "$pub/bin/docker"
ln -s client.py "$pub/bin/gh"
ln -s client.py "$pub/bin/curl"
export FIXTURE_ROOT="$REPO_ROOT" FIXTURE_STATE="$pub" PATH="$pub/bin:$PATH"
export GITHUB_REPOSITORY=cogni-dao/cogni GITHUB_REPOSITORY_OWNER=cogni-dao GH_TOKEN=fixture GHCR_USERNAME=fixture GHCR_TOKEN=fixture
export FIXTURE_SOURCE="$(git -C "$REPO_ROOT" rev-parse HEAD)" GITHUB_WORKFLOW_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
export FIXTURE_DIGEST="sha256:7777777777777777777777777777777777777777777777777777777777777777" GITHUB_RUN_ID=99001 GITHUB_RUN_ATTEMPT=1
export SOURCE_REPOSITORY=cogni-dao/cogni BUILD_SHA="$FIXTURE_SOURCE" IMAGE_TAG="sha-$FIXTURE_SOURCE"
export PUBLICATION_COORDINATE="ghcr.io/cogni-dao/cogni-template:sha-$FIXTURE_SOURCE-linux/amd64"
export TARGETS=operator OUTPUT_FILE="$pub/new.json" GITHUB_OUTPUT="$pub/outputs"
export COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog"
export GITHUB_STEP_SUMMARY="$pub/summary"
(cd "$REPO_ROOT"; LOST_PUSH=1 bash scripts/ci/build-and-push-images.sh) > "$pub/build.log"
[[ ! -e "$OUTPUT_FILE" && -s "$OUTPUT_FILE.pending" ]]
(cd "$REPO_ROOT"; PUBLICATION_PHASE=finalize bash scripts/ci/build-and-push-images.sh)
jq -e '.targets[0].publication.producer.run_id == "99001" and .targets[0].outcome == "built"' "$OUTPUT_FILE" >/dev/null
cp "$OUTPUT_FILE" "$pub/retained.json"
for mode in api oci retained; do
  export NATIVE_MODE="$mode" GITHUB_RUN_ID=99002 OUTPUT_FILE="$pub/reused-$mode.json"
  (cd "$REPO_ROOT"; bash scripts/ci/build-and-push-images.sh) > "$pub/reused-$mode.log"
  jq -e '.targets[0].publication.producer.run_id == "99001" and .targets[0].outcome == "reused"' "$OUTPUT_FILE" >/dev/null
done
[[ $(grep -c '^docker buildx build ' "$pub/calls") == 1 ]]
echo '[PASS] producer reconciles lost push response, then reuses original native identity after fragment expiry/aggregate replacement and retained-bundle recovery'

# Round-trip original signed evidence through the real fragment and manifest
# writers. Conflicting target records must refuse rather than first-record-win.
mkdir -p "$pub/fragments"
cp "$OUTPUT_FILE" "$pub/fragments/operator.json"
FRAGMENTS_DIR="$pub/fragments" OUTPUT_FILE="$pub/merged.json" bash "$REPO_ROOT/scripts/ci/merge-build-fragments.sh"
IMAGES_FILE="$pub/merged.json" MANIFEST_FILE="$pub/manifest.json" HEAD_SHA="$FIXTURE_SOURCE" REPOSITORY=cogni-dao/cogni bash "$REPO_ROOT/scripts/ci/write-build-manifest.sh"
jq -S '.targets' "$OUTPUT_FILE" > "$pub/original-targets"
jq -S '.targets' "$pub/manifest.json" > "$pub/roundtrip-targets"
cmp "$pub/original-targets" "$pub/roundtrip-targets"
jq '.targets[0].digest="ghcr.io/cogni-dao/cogni-template@sha256:conflict"' "$OUTPUT_FILE" > "$pub/fragments/conflict.json"
if FRAGMENTS_DIR="$pub/fragments" OUTPUT_FILE="$pub/conflict.json" bash "$REPO_ROOT/scripts/ci/merge-build-fragments.sh"; then
  echo '[FAIL] conflicting publication evidence merged'; exit 1
fi
rm "$pub/fragments/conflict.json"
echo '[PASS] manifest round-trip preserves source, target, digest, recipe, original producer and bundle; conflicts refuse'

# Expired fragments and an aggregate-only rerun use native original proof;
# neither path compiles or attributes the bytes to this consumer attempt.
mkdir -p "$pub/expired-fragments"
NATIVE_MODE=api EXPECTED_TARGETS_JSON='["operator"]' HEAD_SHA="$FIXTURE_SOURCE" \
  FRAGMENTS_DIR="$pub/expired-fragments" OUTPUT_FILE="$pub/recovered.json" \
  bash "$REPO_ROOT/scripts/ci/merge-build-fragments.sh"
jq -e '.targets[0].publication.producer.run_id == "99001" and .targets[0].outcome == "reused"' "$pub/recovered.json" >/dev/null
[[ $(grep -c '^docker buildx build ' "$pub/calls") == 1 ]]
echo '[PASS] actual aggregate-only rerun recovers expired fragments without rebuilding'

# Corrected proof failures must refuse the actual nodeRef and PR readers, with
# no stale output. Total proof loss cannot trigger another build or tag write.
export NATIVE_MODE=api SOURCE_SHA="$FIXTURE_SOURCE" NODE=operator
for defect in source target recipe platform subject signer missing-fields; do
  for reader in resolve-node-ref-image resolve-pr-build-images; do
    export OUTPUT_FILE="$pub/refused.json"
    echo '{"targets":[{"target":"stale"}]}' > "$OUTPUT_FILE"
    if DEFECT="$defect" bash "$REPO_ROOT/scripts/ci/$reader.sh" > "$pub/$reader-$defect.log" 2>&1; then
      echo "[FAIL] $reader accepted $defect"; exit 1
    fi
    [[ ! -f "$OUTPUT_FILE" ]]
  done
done
for established in true false; do
  for defect in source target recipe platform subject signer missing-fields; do
    if (cd "$lab"; DEFECT="$defect" GH_TOKEN=fixture NODE=operator \
        COGNI_CATALOG_ROOT="$lab/app-src/infra/catalog" SOURCE_REPOSITORY=cogni-dao/cogni \
        DEPLOYMENT_PROVIDER=k3s DESTINATION_ESTABLISHED="$established" PRESERVE_APP=false \
        PREVIEW_FORWARD=false BUILD_SHA="$FIXTURE_SOURCE" NODE_SOURCE_SHA='' \
        OPERATOR_SOURCE_SHA="$FIXTURE_SOURCE" CATALOG_SOURCE_SHA='' PREVIEW_SOURCE_SHA_MAP='' \
        OVERLAY_ENV=production EXPLICIT_TARGETS=operator RUNNER_TEMP="$pub" \
        GITHUB_OUTPUT="$pub/promotion.out" bash "$work/digest.sh") > "$pub/promotion-$established-$defect.log" 2>&1; then
      echo "[FAIL] promotion accepted $established/$defect"; exit 1
    fi
  done
done
export NATIVE_MODE=none OUTPUT_FILE="$pub/lost.json"
if (cd "$REPO_ROOT"; bash scripts/ci/build-and-push-images.sh) > "$pub/lost.log" 2>&1; then
  echo '[FAIL] producer accepted total proof loss'; exit 1
fi
[[ $(grep -c '^docker buildx build ' "$pub/calls") == 1 ]]
for error in 'unauthorized' 'connection reset' 'manifest unknown: 503'; do
  export OUTPUT_FILE="$pub/ambiguous.json"
  if (cd "$REPO_ROOT"; LOOKUP_ERROR="$error" bash scripts/ci/build-and-push-images.sh) > "$pub/ambiguous.log" 2>&1; then
    echo '[FAIL] ambiguous lookup authorized publication'; exit 1
  fi
done
[[ $(grep -c '^docker buildx build ' "$pub/calls") == 1 ]]
echo '[PASS] all actual discovery readers refuse mismatched native claims; total loss/auth/transport ambiguity never permits rebuild'

# Explicit authenticated legacy definition, actual source and immutable subject.
export LEGACY=1 LEGACY_MANIFEST="$mq" FIXTURE_SOURCE="$accepted_source" SOURCE_SHA="$accepted_source" FIXTURE_DIGEST="${accepted_ref##*@}"
python3 - "$pub/config.json" "$accepted_source" <<'PY'
import json,sys
json.dump({'os':'linux','architecture':'amd64','config':{'Labels':{'org.opencontainers.image.revision':sys.argv[2], 'org.opencontainers.image.source':'https://github.com/cogni-dao/cogni'}}},open(sys.argv[1],'w'))
PY
export OUTPUT_FILE="$pub/legacy.json"
bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh"
jq -e '.targets[0].publication.kind == "legacy-v1" and .targets[0].publication.producer.run_id == "41163851879"' "$OUTPUT_FILE" >/dev/null
if DEFECT=missing-fields bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/not-legacy.log" 2>&1; then
  echo '[FAIL] corrected producer without new fields downgraded to legacy'; exit 1
fi
unset LEGACY
# A genuine unmodified sovereign publication needs no new operator attestation
# entitlement or fields. The actual reader retains its existing catalog contract.
mkdir -p "$pub/sovereign/infra/catalog"
cat > "$pub/sovereign/infra/catalog/remote.yaml" <<'YAML'
name: remote
type: node
source_repo: acme/remote
image_repository: ghcr.io/acme/remote
YAML
export NODE=remote COGNI_CATALOG_ROOT="$pub/sovereign/infra/catalog" OUTPUT_FILE="$pub/sovereign.json"
bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh"
jq -e '.targets[0].source_repo == "acme/remote" and (.targets[0] | has("publication") | not)' "$OUTPUT_FILE" >/dev/null
echo '[PASS] authentic legacy-v1 and unmodified sovereign contracts remain selectable'

# Native lock group inputs: aliases share a physical tag; unrelated source tags
# remain independent; content-hash infra keeps its existing cross-source identity.
(
  unset SOURCE_SHA
  export COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog"
  . "$REPO_ROOT/scripts/ci/lib/image-tags.sh"
  . "$REPO_ROOT/scripts/ci/lib/publication-proof.sh"
  IMAGE_TAG="sha-$accepted_source" publication_matrix '["operator","litellm"]' > "$pub/matrix-a.json"
  IMAGE_TAG="sha-$new_source" publication_matrix '["operator","litellm"]' > "$pub/matrix-b.json"
  [[ $(jq -r '.[] | select(.target=="operator") | .publication_coordinate' "$pub/matrix-a.json") != "$(jq -r '.[] | select(.target=="operator") | .publication_coordinate' "$pub/matrix-b.json")" ]]
  [[ $(jq -r '.[] | select(.target=="litellm") | .publication_coordinate' "$pub/matrix-a.json") == "$(jq -r '.[] | select(.target=="litellm") | .publication_coordinate' "$pub/matrix-b.json")" ]]
  _image_tags_suffix_cache[alias]="${_image_tags_suffix_cache[operator]}"
  _image_tags_type_cache[alias]=node
  IMAGE_TAG="sha-$accepted_source" publication_matrix '["operator","alias"]' > "$pub/matrix-alias.json"
  [[ $(jq '[.[].publication_coordinate] | unique | length' "$pub/matrix-alias.json") == 1 ]]
)
echo '[PASS] native job-lock inputs serialize physical aliases, separate unrelated sources, and preserve content-hash infrastructure semantics'

# Initial lane detection must distinguish a shared umbrella's generated shape
# from malformed established acceptance. Parse errors do not become bootstrap.
initial="$work/initial-umbrella"
mkdir -p "$initial/infra/k8s/overlays/production/new" "$initial/.promote-state"
printf '{"other":"%s"}\n' "$accepted_source" > "$initial/.promote-state/source-sha-by-app.json"
printf 'images:\n  - name: ghcr.io/cogni-dao/cogni-template\n    newTag: prod-placeholder-new\n' > "$initial/infra/k8s/overlays/production/new/kustomization.yaml"
(
  cd "$initial"
  . "$REPO_ROOT/scripts/ci/lib/overlay-digest.sh"
  [[ $(umbrella_app_is_established production new) == false ]]
  printf '{"new":"malformed"}\n' > .promote-state/source-sha-by-app.json
  [[ $(umbrella_app_is_established production new) == true ]]
  printf '{"new":"a","new":"b"}\n' > .promote-state/source-sha-by-app.json
  if umbrella_app_is_established production new > "$work/duplicate-map.log" 2>&1; then
    echo '[FAIL] duplicate acceptance became an initial lane'; exit 1
  fi
)
echo '[PASS] genuine initial umbrella shape remains promotable; malformed acceptance never bootstraps'
