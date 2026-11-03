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
ln -s "$REPO_ROOT/scripts/ci/promote-k8s-image.sh" "$work/ci-src/scripts/ci/promote-k8s-image.sh"
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
mkdir -p "$pub/bin" "$pub/current"
# A clean real Git checkout supplies immutable C even while this test's source
# checkout contains uncommitted edits. Preserve historical objects separately.
export FIXTURE_GIT="$REPO_ROOT"
git -C "$REPO_ROOT" archive HEAD scripts/ci .github/workflows infra nodes/operator/app/Dockerfile .cogni/repo-spec.yaml | tar -x -C "$pub/current"
cp "$REPO_ROOT/scripts/ci/lib/publication-proof.sh" "$pub/current/scripts/ci/lib/publication-proof.sh"
printf '\n# Compatible reader R2 fixture.\n' >> "$pub/current/.github/workflows/pr-build.yml"
git -C "$pub/current" init -q
git -C "$pub/current" config user.name fixture
git -C "$pub/current" config user.email fixture@example.test
git -C "$pub/current" remote add origin https://github.com/cogni-dao/cogni.git
git -C "$pub/current" add .
git -C "$pub/current" -c core.hooksPath=/dev/null commit -qm 'trusted immutable reader fixture'
REPO_ROOT="$pub/current"
rm "$lab/ci-src"
ln -s "$REPO_ROOT" "$lab/ci-src"
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
        output.write_text(json.dumps({'token':'fixture-authenticated-pull'})); print('404' if os.environ.get('REGISTRY_ERROR') == 'anonymous' else '200',end='')
    else:
        defect = os.environ.get('REGISTRY_ERROR', '')
        if defect == 'transport': fail('fixture connection reset')
        if defect == 'malformed': output.write_text('not json'); print('404',end='')
        else:
            code = 'NAME_UNKNOWN' if defect == 'repository' else 'DENIED' if defect == 'auth' else 'MANIFEST_UNKNOWN'
            status = '503' if defect == '503' else '401' if defect == 'auth' else '404'
            output.write_text(json.dumps({'errors':[{'code':code}]})); print(status,end='')
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
        if not (state / 'present').exists(): fail('ERROR: ' + subject + ': not found')
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
if '/git/commits/' in endpoint:
    revision = endpoint.rsplit('/', 1)[1]
    data = subprocess.check_output(['git', '-C', str(root), 'show', '-s', '--format=%P', revision]).decode().split()
    if os.environ.get('DEFECT') == 'execution-parents': data = []
    emit({'sha':revision, 'parents':[{'sha':p} for p in data]}); sys.exit(0)
if '/commits/' in endpoint:
    if os.environ.get('DEFECT') == 'unauthorized-repository': fail('commit not authorized in requested repository')
    emit({'sha':os.environ['FIXTURE_SOURCE']}); sys.exit(0)
if '/contents/' in endpoint:
    path = endpoint.split('/contents/',1)[1].split('?',1)[0]
    legacy = os.environ.get('LEGACY') == '1'
    revision = endpoint.split('?ref=', 1)[1]
    legacy_definition = 'f66aae9ee44fc74bda9e12623eb4c862c524e1d8'
    if legacy and os.environ.get('DEFECT') != 'missing-fields':
        # Distinct native workflow and application checkout identities. Route
        # validation makes an incorrectly conflated implementation fail.
        workflow_path = path == '.github/workflows/pr-build.yml'
        expected_revision = os.environ.get('LEGACY_EXECUTION', legacy_definition) if workflow_path else os.environ['FIXTURE_SOURCE']
        assert revision == expected_revision, (path, revision, expected_revision)
        history = str(root) if os.environ.get('LEGACY_EXECUTION') else os.environ['FIXTURE_GIT']
        data = subprocess.check_output(['git', '-C', history, 'show', revision + ':' + path])
        if os.environ.get('DEFECT') == 'legacy-helper' and path == 'scripts/ci/lib/image-tags.sh': data += b'\n# unqualified helper\n'
    else:
        history = os.environ['FIXTURE_GIT'] if revision in ('29e194ab8b068b2c7bb3eb48803c8083f811ad84', '02a72ff131b43f32e6d4a3292621c14d28c6f84c') else str(root)
        data = subprocess.check_output(['git', '-C', history, 'show', revision + ':' + path])
    if os.environ.get('DEFECT') == 'signer' and '.github/workflows' in path: data = b'foreign workflow'
    import hashlib
    blob = hashlib.sha1(b'blob ' + str(len(data)).encode() + b'\0' + data).hexdigest()
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
    if '/jobs?' in endpoint:
        checkout = 'Run actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955'
        def job(identifier, name, names):
            steps = [{'number':i,'name':n,'conclusion':'success'} for i,n in enumerate(['Set up job',checkout]+names,1)]
            if os.environ.get('DEFECT') == name.split(' ')[0] + '-step': steps[1]['name'] = 'arbitrary shell'
            return {'id':identifier,'name':name,'conclusion':'success','run_id':41163851879,'run_attempt':1,'steps':steps}
        jobs = [job(43,'build (operator)',['Set up Docker Buildx','Login to GHCR','Build and push operator','Upload build fragment']),
                job(45,'manifest',['Download build fragments','Merge fragments into build-images.json','Write build manifest','Upload build manifest'])]
        if os.environ.get('LEGACY_EVENT') == 'pull_request' and os.environ.get('DEFECT') != 'missing-execution':
            steps = [{'number':1,'name':'Set up job','conclusion':'success'},
                     {'number':2,'name':'Run actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955','conclusion':'success'}]
            jobs.append({'id':44,'name':'env-manager-fast-path','conclusion':'success','run_id':41163851879,'run_attempt':1,'steps':steps})
        emit({'total_count':len(jobs),'jobs':jobs})
    else:
        legacy = os.environ.get('LEGACY') == '1'
        head = os.environ['FIXTURE_SOURCE'] if os.environ.get('LEGACY_EVENT') == 'pull_request' or not legacy else 'f66aae9ee44fc74bda9e12623eb4c862c524e1d8'
        event = os.environ.get('LEGACY_EVENT', 'push' if os.environ.get('DEFECT') == 'wrong-actual-repository' else 'workflow_dispatch')
        emit({'path':'.github/workflows/pr-build.yml','conclusion':os.environ.get('ORIGINAL_CONCLUSION', 'success') if '/attempts/' in endpoint else 'failure',
              'head_sha':head,'run_attempt':int(os.environ.get('ORIGINAL_ATTEMPT', '1')) if '/attempts/' in endpoint else 2,
              'id':int(endpoint.split('/actions/runs/')[1].split('/')[0]),'event':event,
              'pull_requests':[{'base':{'sha':'f66aae9ee44fc74bda9e12623eb4c862c524e1d8'},'head':{'sha':head}}]})
    sys.exit(0)
if '/actions/jobs/44/logs' in endpoint:
    action = 'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955'
    header = ['Complete job name: env-manager-fast-path','##[group]Run ' + action,'with:','  fetch-depth: 0','  repository: cogni-dao/cogni','env:','  IMAGE_NAME: ghcr.io/cogni-dao/cogni-template','##[endgroup]']
    defect = os.environ.get('DEFECT')
    if defect == 'execution-ref': header.insert(4, '  ref: ' + os.environ['FIXTURE_SOURCE'])
    if defect == 'execution-shell': header.insert(3, 'shell: /usr/bin/bash -e {0}')
    body = ['[command]/usr/bin/git log -1 --format=%H',os.environ['LEGACY_EXECUTION']]
    if defect == 'execution-unresolved': body = []
    if defect == 'execution-duplicate': body += body
    if defect == 'execution-late-text': body = ['##[group]Run echo untrusted'] + body
    print('\n'.join(header + body)); sys.exit(0)
if '/actions/jobs/' in endpoint:
    job = 'build' if '/43/' in endpoint else 'manifest'
    name = 'build (operator)' if job == 'build' else 'manifest'
    action = 'actions/checkout@08eba0b27e820071cde6df949e0beb9ba4906955'
    source = os.environ['FIXTURE_SOURCE']; defect = os.environ.get('DEFECT', '')
    defect = defect[len(job)+1:] if defect.startswith(job+'-') else ''
    repository = 'wrong/repository' if defect == 'repo' else 'cogni-dao/cogni'
    revision = 'e'*40 if defect == 'ref' else source
    header = ['Complete job name: '+name,'##[group]Run '+action,'with:',
              '  repository: '+repository,'  ref: '+revision,'  fetch-depth: 1','  token: ***',
              'env:','  IMAGE_NAME: ghcr.io/cogni-dao/cogni-template','  FLEET_CONTROL_ENV: production',
              '  IMAGE_TAG: sha-'+source,'  HEAD_SHA: '+source,'##[endgroup]']
    if defect == 'duplicate-input': header.insert(4,'  repository: cogni-dao/cogni')
    if defect == 'server': header.insert(4,'  github-server-url: https://foreign.invalid')
    if defect == 'env': header.insert(-1,'  INPUT_REPOSITORY: wrong/repository')
    body = ['Syncing repository: '+repository,'[command]/usr/bin/git checkout --progress --force '+revision,
            '[command]/usr/bin/git log -1 --format=%H','e'*40 if defect == 'head' else source]
    if defect == 'duplicate-head': body += body[-2:]
    if defect == 'missing-head': body = body[:-2]
    if defect == 'late-head': body = body[:-2]+['##[group]Run echo untrusted']+body[-2:]
    if defect == 'late-checkout': header.insert(1,'##[group]Run echo untrusted')
    # Arbitrary later user output claims S in every counterexample. This is not
    # checkout authority, even when an unsigned manifest also claims S.
    tail = ['##[group]Run echo untrusted','repository: cogni-dao/cogni','ref: '+source]
    print('\ufeff'+'\n'.join('2026-10-31T03:19:42.0000000Z '+line for line in header+body+tail)); sys.exit(0)
fail('unexpected gh endpoint ' + endpoint)
PY
chmod +x "$pub/bin/client.py"
ln -s client.py "$pub/bin/docker"
ln -s client.py "$pub/bin/gh"
ln -s client.py "$pub/bin/curl"
export FIXTURE_ROOT="$REPO_ROOT" FIXTURE_STATE="$pub" PATH="$pub/bin:$PATH"
export GITHUB_REPOSITORY=cogni-dao/cogni GITHUB_REPOSITORY_OWNER=cogni-dao GH_TOKEN=fixture GHCR_USERNAME=fixture GHCR_TOKEN=fixture
export FIXTURE_SOURCE="$(git -C "$REPO_ROOT" rev-parse HEAD)" GITHUB_WORKFLOW_SHA="$(git -C "$REPO_ROOT" rev-parse HEAD)"
export GITHUB_WORKFLOW_REF=cogni-dao/cogni/.github/workflows/pr-build.yml@refs/heads/main
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

# Trusted producer labels bind the actual checkout. The operation independently
# authorizes the exact commit in its declared repository, including nodeRef with
# no current PR. Repo equality must not confuse the workflow with the checkout.
cp "$pub/config.json" "$pub/native-config.json"
python3 - "$pub/config.json" <<'PYTHON'
import json,sys
p=sys.argv[1]; d=json.load(open(p)); l=d['config']['Labels']
l['io.cogni.publication.source']='contributor/cogni'
l['org.opencontainers.image.source']='https://github.com/contributor/cogni'
json.dump(d,open(p,'w'))
PYTHON
for reader in resolve-node-ref-image resolve-pr-build-images; do
  NODE=operator SOURCE_SHA="$FIXTURE_SOURCE" SOURCE_REPOSITORY=cogni-dao/cogni NATIVE_MODE=api \
    OUTPUT_FILE="$pub/foreign-$reader.json" bash "$REPO_ROOT/scripts/ci/$reader.sh"
  jq -e '.targets[] | select(.target=="operator") | .publication.source_repository == "contributor/cogni"' "$pub/foreign-$reader.json" >/dev/null
  if NODE=operator SOURCE_SHA="$FIXTURE_SOURCE" SOURCE_REPOSITORY=unapproved/repo NATIVE_MODE=api \
      DEFECT=unauthorized-repository OUTPUT_FILE="$pub/foreign-refused.json" \
      bash "$REPO_ROOT/scripts/ci/$reader.sh" > "$pub/foreign-refused.log" 2>&1; then
    echo '[FAIL] operation accepted unauthorized source repository'; exit 1
  fi
  [[ ! -e "$pub/foreign-refused.json" ]]
  if NODE=operator SOURCE_SHA="$FIXTURE_SOURCE" SOURCE_REPOSITORY=cogni-dao/cogni NATIVE_MODE=api \
      DEFECT=wrong-actual-repository OUTPUT_FILE="$pub/foreign-refused.json" \
      bash "$REPO_ROOT/scripts/ci/$reader.sh" > "$pub/wrong-actual.log" 2>&1; then
    echo '[FAIL] foreign source without authenticated dispatch accepted'; exit 1
  fi
  [[ ! -e "$pub/foreign-refused.json" ]]
done
NATIVE_MODE=api SOURCE_REPOSITORY=contributor/cogni EXPECTED_TARGETS_JSON='["operator"]' HEAD_SHA="$FIXTURE_SOURCE" \
  FRAGMENTS_DIR="$pub/foreign-expired" OUTPUT_FILE="$pub/foreign-recovered.json" \
  bash "$REPO_ROOT/scripts/ci/merge-build-fragments.sh"
jq -e '.targets[0].publication.source_repository == "contributor/cogni" and .targets[0].publication.producer.run_id == "99001"' "$pub/foreign-recovered.json" >/dev/null
cp "$pub/native-config.json" "$pub/config.json"
echo '[PASS] actual foreign checkout survives PR/nodeRef and aggregate recovery; unauthorized operation repo refuses'

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
for defect in wrong-attempt failed-original legacy-helper; do
  if [[ "$defect" == wrong-attempt ]]; then
    export ORIGINAL_ATTEMPT=2 ORIGINAL_CONCLUSION=success
  elif [[ "$defect" == failed-original ]]; then
    export ORIGINAL_ATTEMPT=1 ORIGINAL_CONCLUSION=failure
  else
    unset ORIGINAL_ATTEMPT ORIGINAL_CONCLUSION
  fi
  if DEFECT="$defect" bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/$defect.log" 2>&1; then
    echo "[FAIL] accepted legacy $defect"; exit 1
  fi
  [[ ! -e "$OUTPUT_FILE" ]]
done
unset ORIGINAL_ATTEMPT ORIGINAL_CONCLUSION
# The mutable latest attempt is FAILED/2 in the fixture; the retained original
# manifest and original attempt-specific job still select SUCCESS/1.
bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh"
jq -e '.targets[0].publication.producer.run_attempt == "1"' "$OUTPUT_FILE" >/dev/null
grep -q 'actions/runs/41163851879/attempts/1/jobs' "$pub/calls"
echo '[PASS] legacy original attempt survives later failure; wrong/failed original attempts refuse'
# R58: later source claims cannot replace the native first app checkout in
# either producer or unsigned aggregation. Exercise real helpers/Git blobs.
for job in build manifest; do
  for defect in repo ref head duplicate-input duplicate-head missing-head late-head late-checkout server env step; do
    if DEFECT="$job-$defect" bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/$job-$defect.log" 2>&1; then
      echo "[FAIL] accepted legacy $job-$defect with later forged source text"; exit 1
    fi
    [[ ! -e "$OUTPUT_FILE" ]]
  done
done
echo '[PASS] native build and manifest first checkouts reject forged later source, wrong HEAD, ambiguity and overrides'

# Real immutable Git objects distinguish PR application S from executed M.
# S deliberately has a BAD workflow; only M carries the frozen workflow.
git -C "$REPO_ROOT" fetch -q --no-tags "$FIXTURE_GIT" "$accepted_source" f66aae9ee44fc74bda9e12623eb4c862c524e1d8
GIT_INDEX_FILE="$pub/legacy-index" git -C "$REPO_ROOT" read-tree "$accepted_source"
printf 'unqualified workflow\n' > "$pub/legacy-bad-workflow"
bad_workflow=$(git -C "$REPO_ROOT" hash-object -w "$pub/legacy-bad-workflow")
GIT_INDEX_FILE="$pub/legacy-index" git -C "$REPO_ROOT" update-index --cacheinfo "100644,$bad_workflow,.github/workflows/pr-build.yml"
source_tree=$(GIT_INDEX_FILE="$pub/legacy-index" git -C "$REPO_ROOT" write-tree)
pr_source=$(printf 'legacy PR application fixture\n' | git -C "$REPO_ROOT" commit-tree "$source_tree" -p "$accepted_source")
base=f66aae9ee44fc74bda9e12623eb4c862c524e1d8
merge=$(printf 'retained PR merge execution\n' | git -C "$REPO_ROOT" commit-tree "$base^{tree}" -p "$base" -p "$pr_source")
export LEGACY_EVENT=pull_request LEGACY_EXECUTION="$merge" FIXTURE_SOURCE="$pr_source" SOURCE_SHA="$pr_source"
jq --arg s "$pr_source" '.head_sha=$s | .targets[0].tag="ghcr.io/cogni-dao/cogni-template:sha-"+$s' "$mq" > "$pub/pr-legacy-manifest.json"
export LEGACY_MANIFEST="$pub/pr-legacy-manifest.json"
jq --arg s "$pr_source" '.config.Labels["org.opencontainers.image.revision"]=$s' "$pub/config.json" > "$pub/pr-config.json"
mv "$pub/pr-config.json" "$pub/config.json"
bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh"
jq -e --arg m "$merge" '.targets[0].publication.producer | .revision == $m and .run_attempt == "1"' "$OUTPUT_FILE" >/dev/null
for defect in missing-execution execution-parents execution-ref execution-shell execution-unresolved execution-duplicate execution-late-text; do
  if DEFECT="$defect" bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/$defect.log" 2>&1; then
    echo "[FAIL] accepted PR $defect"; exit 1
  fi
  [[ ! -e "$OUTPUT_FILE" ]]
  grep -Eq 'publication_legacy_execution_(unresolved|contradiction)' "$pub/$defect.log"
done
# Inverse: frozen S cannot bless changed actual M.
export FIXTURE_SOURCE="$accepted_source" SOURCE_SHA="$accepted_source" LEGACY_MANIFEST="$mq"
bad_merge=$(printf 'bad actual execution\n' | git -C "$REPO_ROOT" commit-tree "$source_tree" -p "$base" -p "$accepted_source")
export LEGACY_EXECUTION="$bad_merge"
jq --arg s "$accepted_source" '.config.Labels["org.opencontainers.image.revision"]=$s' "$pub/config.json" > "$pub/pr-config.json"
mv "$pub/pr-config.json" "$pub/config.json"
if bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/bad-execution.log" 2>&1; then
  echo '[FAIL] frozen source blessed bad actual workflow'; exit 1
fi
grep -q publication_legacy_definition_mismatch "$pub/bad-execution.log"
[[ ! -e "$OUTPUT_FILE" ]]
unset LEGACY_EVENT LEGACY_EXECUTION LEGACY
echo '[PASS] legacy PR merge execution and app source stay separate; missing/contradictory/late/free-text identity refuses'
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

# Exercise real native branch history, including provision 4c's preview digest
# copy. A marker, commit message or placeholder alone is never proof.
initial="$work/initial-lane"
mkdir -p "$initial/infra/k8s/overlays/production/operator" "$initial/infra/k8s/overlays/preview/operator" "$initial/infra/catalog"
cp "$REPO_ROOT/infra/catalog/operator.yaml" "$initial/infra/catalog/"
printf 'images:\n  - name: ghcr.io/cogni-dao/cogni-template\n    newName: ghcr.io/cogni-dao/cogni-template\n    digest: "sha256:%064d"\n' 0 > "$initial/infra/k8s/overlays/production/operator/kustomization.yaml"
printf 'images:\n  - name: ghcr.io/cogni-dao/cogni-template\n    newName: ghcr.io/cogni-dao/cogni-template\n    digest: "%s"\n' "${accepted_ref##*@}" > "$initial/infra/k8s/overlays/preview/operator/kustomization.yaml"
(
  cd "$initial"
  git init -q
  git config user.name fixture
  git config user.email fixture@example.test
  git add .; git commit -qm source
  git update-ref refs/remotes/origin/main HEAD
  . "$REPO_ROOT/scripts/ci/lib/overlay-digest.sh"
  [[ $(destination_app_is_established production operator) == false ]]
  # This is the exact existing phase-4c digest substitution, without acceptance.
  sed -i.bak -E "s|(^[[:space:]]*digest:[[:space:]]*\").*(\")|\\1${accepted_ref##*@}\\2|" infra/k8s/overlays/production/operator/kustomization.yaml
  rm infra/k8s/overlays/production/operator/kustomization.yaml.bak
  mkdir .promote-state
  printf '{"other":"%s"}\n' "$accepted_source" > .promote-state/source-sha-by-app.json
  git add .; git commit -qm 'arbitrary text is not seed authority'
  initial_established=$(destination_app_is_established production operator)
  [[ "$initial_established" == false ]]
  # The real digest step selects the qualified publication from this seed state.
  cp "$pub/native-config.json" "$pub/config.json"
  export FIXTURE_SOURCE=$(jq -r '.config.Labels["org.opencontainers.image.revision"]' "$pub/native-config.json")
  native_ref=$(jq -r '.targets[0].digest' "$pub/retained.json")
  export FIXTURE_DIGEST="${native_ref##*@}"
  (cd "$lab"; NODE=operator COGNI_CATALOG_ROOT="$lab/app-src/infra/catalog" \
    SOURCE_REPOSITORY=cogni-dao/cogni SOURCE_SHA="$FIXTURE_SOURCE" BUILD_SHA="$FIXTURE_SOURCE" \
    NATIVE_MODE=api DEPLOYMENT_PROVIDER=k3s PREVIEW_FORWARD=false \
    DESTINATION_ESTABLISHED="$initial_established" PRESERVE_APP=false \
    OVERLAY_ENV=production EXPLICIT_TARGETS=operator RUNNER_TEMP="$pub" \
    GITHUB_OUTPUT="$work/seed-promotion.out" bash "$work/digest.sh")
  grep -qx "digest=ghcr.io/cogni-dao/cogni-template@$FIXTURE_DIGEST" "$work/seed-promotion.out"
  # Full infra cannot use even a proven initial branch.
  if (cd "$lab"; NODE=operator COGNI_CATALOG_ROOT="$lab/app-src/infra/catalog" \
      SOURCE_REPOSITORY=cogni-dao/cogni BUILD_SHA="$accepted_source" \
      DEPLOYMENT_PROVIDER=k3s PREVIEW_FORWARD=false DESTINATION_ESTABLISHED=false \
      PRESERVE_APP=true OVERLAY_ENV=production GITHUB_OUTPUT="$work/seed-infra.out" \
      bash "$work/digest.sh") > "$work/seed-infra.log" 2>&1; then
    echo '[FAIL] uninitialized full infra replay accepted'; exit 1
  fi
  grep -q accepted_app_missing "$work/seed-infra.log"
  NODE=operator OVERLAY_ENV=production DIGEST="$native_ref" SOURCE_SHA="$FIXTURE_SOURCE" bash "$lab/write.sh"
  [[ $(yq -r '.images[0].digest' infra/k8s/overlays/production/operator/kustomization.yaml) == "$FIXTURE_DIGEST" ]]
  [[ $(jq -r .operator .promote-state/source-sha-by-app.json) == "$FIXTURE_SOURCE" ]]
  git add .; git commit -qm accepted
  rm .promote-state/source-sha-by-app.json
  git add -A; git commit -qm damaged
  [[ $(destination_app_is_established production operator) == true ]]
  # Truncated native history is never absence of acceptance.
  git update-ref -d refs/remotes/origin/main
  if destination_app_is_established production absent > "$work/seed-incomplete.log" 2>&1; then
    echo '[FAIL] incomplete seed history bootstrapped'; exit 1
  fi
)
echo '[PASS] provision digest seed is initial; damaged acceptance remains established; full infra and incomplete history refuse'

# Trust-policy seams use the actual private verifier and immutable real Git
# blobs. Only external clients are fixtures: this is NOT cryptographic proof.
trap 'result=$?; if [[ "$result" != 0 ]]; then tail -n 12 "$pub"/history-*.log "$pub"/unknown-*.log "$pub"/*reader.log "$pub"/wrong-current.log "$pub"/retired-history.log 2>/dev/null || :; fi; rm -rf "$work"' EXIT
export NODE=operator COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" NATIVE_MODE=api
export FIXTURE_SOURCE=$(jq -r '.config.Labels["org.opencontainers.image.revision"]' "$pub/native-config.json")
export SOURCE_SHA="$FIXTURE_SOURCE" BUILD_SHA="$FIXTURE_SOURCE" HEAD_SHA="$FIXTURE_SOURCE"
export FIXTURE_DIGEST="sha256:7777777777777777777777777777777777777777777777777777777777777777"
r2="$GITHUB_WORKFLOW_SHA"
r1=29e194ab8b068b2c7bb3eb48803c8083f811ad84
set_signer() {
  jq --arg revision "$1" '.config.Labels["io.cogni.publication.workflow-sha"]=$revision' "$pub/native-config.json" > "$pub/config.json"
}
promotion_discovery() {
  (cd "$lab"; NODE=operator SOURCE_REPOSITORY=cogni-dao/cogni \
    COGNI_CATALOG_ROOT="$lab/app-src/infra/catalog" DEPLOYMENT_PROVIDER=k3s \
    DESTINATION_ESTABLISHED=false PRESERVE_APP=false PREVIEW_FORWARD=false \
    NODE_SOURCE_SHA='' OPERATOR_SOURCE_SHA="$FIXTURE_SOURCE" CATALOG_SOURCE_SHA='' \
    PREVIEW_SOURCE_SHA_MAP='' OVERLAY_ENV=production EXPLICIT_TARGETS=operator \
    RUNNER_TEMP="$pub" GITHUB_OUTPUT="$pub/trust-promotion.out" bash "$work/digest.sh")
}
# The immediately preceding qualified native producer remains reusable after
# this legacy-only reader correction, separately from the older R1 anchor.
set_signer 02a72ff131b43f32e6d4a3292621c14d28c6f84c
for mode in api oci retained; do
  NATIVE_MODE="$mode" OUTPUT_FILE="$pub/previous-$mode.json" bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh"
  jq -e '.targets[0].publication.producer.revision == "02a72ff131b43f32e6d4a3292621c14d28c6f84c"' "$pub/previous-$mode.json" >/dev/null
done
echo '[PASS] preceding qualified 02a72 native producer survives legacy-only correction across API/OCI/bundle'
set_signer "$r1"
for mode in api oci retained; do
  export NATIVE_MODE="$mode"
  for reader in resolve-node-ref-image resolve-pr-build-images; do
    OUTPUT_FILE="$pub/history-$reader-$mode.json" bash "$REPO_ROOT/scripts/ci/$reader.sh" > "$pub/history-$reader-$mode.log" 2>&1
    jq -e --arg r "$r1" '.targets[] | select(.target=="operator") | .publication.producer.revision == $r and .publication.producer.run_id == "99001" and .publication.producer.run_attempt == "1"' "$pub/history-$reader-$mode.json" >/dev/null
  done
  (cd "$REPO_ROOT"; OUTPUT_FILE="$pub/history-producer-$mode.json" bash "$REPO_ROOT/scripts/ci/build-and-push-images.sh") > "$pub/history-producer-$mode.log" 2>&1
  jq -e --arg r "$r1" '.targets[0] | .outcome == "reused" and .publication.producer.revision == $r' "$pub/history-producer-$mode.json" >/dev/null
  promotion_discovery > "$pub/history-promotion-$mode.log" 2>&1
  EXPECTED_TARGETS_JSON='["operator"]' FRAGMENTS_DIR="$pub/history-fragments-$mode" \
    OUTPUT_FILE="$pub/history-aggregate-$mode.json" bash "$REPO_ROOT/scripts/ci/merge-build-fragments.sh" > "$pub/history-aggregate-$mode.log" 2>&1
  jq -e --arg r "$r1" '.targets[0].publication.producer.revision == $r' "$pub/history-aggregate-$mode.json" >/dev/null
done
[[ $(grep -c '^docker buildx build ' "$pub/calls") == 1 ]]
! grep -Eq '^docker (tag|push) |^gh attestation (sign|create) ' "$pub/calls"
echo '[PASS] retained fixed R1 survives compatible R2 through API/OCI/bundle and every owner with no rebuild/retag/reattest'

# Rbad changes ONLY the formerly omitted executable helper. Authenticate actual
# Git objects through the client fixture; plausible signed-result data cannot
# stand in for producer qualification. No live signature is claimed here.
git -C "$REPO_ROOT" fetch -q --no-tags "$FIXTURE_GIT" "$r1"
GIT_INDEX_FILE="$pub/closure-index" git -C "$REPO_ROOT" read-tree "$r1"
(git -C "$REPO_ROOT" show "$r1:scripts/ci/lib/image-tags.sh"; printf '\n# unqualified executable helper\n') > "$pub/bad-helper"
bad_blob=$(git -C "$REPO_ROOT" hash-object -w "$pub/bad-helper")
GIT_INDEX_FILE="$pub/closure-index" git -C "$REPO_ROOT" update-index --cacheinfo "100644,$bad_blob,scripts/ci/lib/image-tags.sh"
bad_tree=$(GIT_INDEX_FILE="$pub/closure-index" git -C "$REPO_ROOT" write-tree)
bad_revision=$(printf 'unqualified omitted helper fixture\n' | git -C "$REPO_ROOT" commit-tree "$bad_tree" -p "$r1")
set_signer "$bad_revision"
for mode in api oci retained; do
  export NATIVE_MODE="$mode"
  for reader in resolve-node-ref-image resolve-pr-build-images build-and-push-images; do
    export OUTPUT_FILE="$pub/unknown-$reader-$mode.json"
    if (cd "$REPO_ROOT"; bash "$REPO_ROOT/scripts/ci/$reader.sh") > "$pub/unknown-$reader-$mode.log" 2>&1; then
      echo "[FAIL] $reader accepted omitted helper through $mode"; exit 1
    fi
    [[ ! -e "$OUTPUT_FILE" ]]
    grep -q publication_signer_implementation_mismatch "$pub/unknown-$reader-$mode.log"
  done
  if promotion_discovery > "$pub/unknown-promotion-$mode.log" 2>&1; then
    echo "[FAIL] promotion accepted omitted helper through $mode"; exit 1
  fi
  grep -q publication_signer_implementation_mismatch "$pub/unknown-promotion-$mode.log"
done
[[ $(grep -c '^docker buildx build ' "$pub/calls") == 1 ]]
echo '[PASS] native verification client fixtures cannot qualify a changed omitted helper through any transport or discovery owner'

set_signer "$r1"
export NATIVE_MODE=api OUTPUT_FILE="$pub/dirty-reader.json"
printf '\n# dirty local reader\n' >> "$REPO_ROOT/scripts/ci/lib/publication-proof.sh"
if bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/dirty-reader.log" 2>&1; then
  echo '[FAIL] dirty reader qualified itself'; exit 1
fi
grep -q publication_reader_worktree_mismatch "$pub/dirty-reader.log"
git -C "$REPO_ROOT" checkout -- scripts/ci/lib/publication-proof.sh
if GITHUB_WORKFLOW_SHA="$r1" bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/wrong-current.log" 2>&1; then
  echo '[FAIL] wrong immutable current revision accepted'; exit 1
fi
grep -q publication_reader_revision_mismatch "$pub/wrong-current.log"
[[ ! -e "$OUTPUT_FILE" ]]
echo '[PASS] dirty executed local verifier and caller-selected wrong C both refuse'

# Remove historical admission in a separate committed fixture C, so a dirty
# reader rejection cannot accidentally satisfy the historical-policy test.
python3 - "$REPO_ROOT/scripts/ci/lib/publication-proof.sh" <<'PY'
from pathlib import Path
import sys
p=Path(sys.argv[1]); s=p.read_text(); s=s.replace('actual != current_native_blobs and actual != retained_native_blobs', 'actual != current_native_blobs'); p.write_text(s)
PY
git -C "$REPO_ROOT" add scripts/ci/lib/publication-proof.sh
git -C "$REPO_ROOT" -c core.hooksPath=/dev/null commit -qm 'fixture retires historical support'
if GITHUB_WORKFLOW_SHA=$(git -C "$REPO_ROOT" rev-parse HEAD) bash "$REPO_ROOT/scripts/ci/resolve-node-ref-image.sh" > "$pub/retired-history.log" 2>&1; then
  echo '[FAIL] historical qualification was ornamental'; exit 1
fi
grep -q publication_signer_implementation_mismatch "$pub/retired-history.log"
git -C "$REPO_ROOT" reset --hard -q "$r2"
echo '[PASS] deleting retained qualification in immutable C refuses historical R1'

# R58: use REAL source commits with status-like digits, tag-bearing native
# diagnostics, actual registry confirmation and the actual build/finalize owner.
# Only external clients are fixtures; no claim of native signatures is made.
original_pub="$pub"
source_parent=$(git -C "$REPO_ROOT" rev-parse HEAD)
source_tree=$(git -C "$REPO_ROOT" rev-parse HEAD^{tree})
for digits in 500 503 595; do
  source=$(python3 - "$REPO_ROOT" "$source_tree" "$source_parent" "$digits" <<'PYTHON'
import subprocess,sys
root,tree,parent,digits=sys.argv[1:]
for i in range(10000):
    sha=subprocess.check_output(['git','-C',root,'commit-tree',tree,'-p',parent],input=f'opaque source {digits} {i}\n'.encode()).decode().strip()
    if digits in sha:
        print(sha);break
else: raise SystemExit('fixture commit search exhausted')
PYTHON
)
  git -C "$REPO_ROOT" checkout --detach -q "$source"
  export FIXTURE_SOURCE="$source" BUILD_SHA="$source" GITHUB_WORKFLOW_SHA="$source"
  export SOURCE_SHA="$source" SOURCE_REPOSITORY=cogni-dao/cogni TARGETS=operator
  export COGNI_CATALOG_ROOT="$REPO_ROOT/infra/catalog" IMAGE_TAG="sha-$source"
  export PUBLICATION_COORDINATE="ghcr.io/cogni-dao/cogni-template:sha-$source-linux/amd64"
  pub="$original_pub/status-$digits"
  mkdir -p "$pub"
  export FIXTURE_STATE="$pub" OUTPUT_FILE="$pub/new.json" GITHUB_OUTPUT="$pub/output"
  export GITHUB_RUN_ID=99001 NATIVE_MODE=api FIXTURE_DIGEST="sha256:7777777777777777777777777777777777777777777777777777777777777777"
  # Lossy not-found diagnostic still needs authenticated typed MANIFEST_UNKNOWN.
  for error in 503 auth transport repository malformed anonymous; do
    if (cd "$REPO_ROOT"; REGISTRY_ERROR="$error" bash scripts/ci/build-and-push-images.sh) > "$pub/registry-$error.log" 2>&1; then
      echo "[FAIL] registry $error authorized build for SHA containing $digits"; exit 1
    fi
    grep -q publication_lookup_failed "$pub/registry-$error.log"
    [[ ! -e "$OUTPUT_FILE" && ! -e "$pub/present" ]]
  done
  for error in 'manifest unknown: HTTP 503' 'unauthorized: not found' 'connection reset: not found'; do
    if (cd "$REPO_ROOT"; LOOKUP_ERROR="$error" bash scripts/ci/build-and-push-images.sh) > "$pub/diagnostic.log" 2>&1; then
      echo '[FAIL] actual diagnostic ambiguity authorized build'; exit 1
    fi
    grep -q publication_lookup_failed "$pub/diagnostic.log"
  done
  [[ $(grep -c '^docker buildx build ' "$pub/calls" || true) == 0 ]]
  # Coordinate words that look like diagnostic errors are equally opaque.
  . "$REPO_ROOT/scripts/ci/lib/publication-proof.sh"
  rc=0
  publication_lookup "ghcr.io/cogni-dao/connection-denied:sha-$source" > "$pub/words.log" 2>&1 || rc=$?
  [[ "$rc" == 3 ]]
  (cd "$REPO_ROOT"; bash scripts/ci/build-and-push-images.sh) > "$pub/build.log"
  [[ ! -e "$OUTPUT_FILE" && -s "$OUTPUT_FILE.pending" ]]
  (cd "$REPO_ROOT"; PUBLICATION_PHASE=finalize bash scripts/ci/build-and-push-images.sh) > "$pub/finalize.log"
  jq -e --arg source "$source" '.targets[0] | .outcome == "built" and .publication.source_sha == $source and .publication.producer.run_id == "99001"' "$OUTPUT_FILE" >/dev/null
  export OUTPUT_FILE="$pub/reused.json" GITHUB_RUN_ID=99002
  (cd "$REPO_ROOT"; bash scripts/ci/build-and-push-images.sh) > "$pub/reused.log"
  jq -e '.targets[0] | .outcome == "reused" and .publication.producer.run_id == "99001"' "$OUTPUT_FILE" >/dev/null
  [[ $(grep -c '^docker buildx build ' "$pub/calls") == 1 ]]
  echo "[PASS] source SHA containing $digits confirms authenticated absence, builds once, finalizes and reuses; unresolved reads never mutate"
done
