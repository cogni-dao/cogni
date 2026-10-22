#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Hermetic client/runner ordering: no SSH, Docker, native DB or real credentials.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
TMPROOT=$(mktemp -d -t template-native-order.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
export NATIVE_FIXTURE_LOG="$TMPROOT/order" NATIVE_FIXTURE_STATE="$TMPROOT/identity"
printf '%s' initial > "$NATIVE_FIXTURE_STATE"
mkdir -p "$TMPROOT/catalog"
cat > "$TMPROOT/catalog/node-template.yaml" <<'YAML'
name: node-template
type: node
envs: [candidate-a]
deployment_provider: {candidate-a: akash}
node_id: b927a9dd-6132-4fc9-a51e-e3cee2568e3c
database: {candidate-a: {tier: shared, budget_profile: shared-default-v1}}
YAML
cat > "$TMPROOT/catalog/operator.yaml" <<'YAML'
name: operator
type: node
envs: [candidate-a, production]
reliability: {controller: true}
YAML
cat > "$TMPROOT/ssh" <<'PY'
#!/usr/bin/env python3
import json,os,pathlib,sys
request=json.load(sys.stdin)
assert request['action'] in ('capture','verify') and request['service'] in ('both','postgres')
assert 'native_preservation' in request['helper'] and 'doltgres:' in request['compose']
with open(os.environ['NATIVE_FIXTURE_LOG'],'a') as log: log.write(request['action']+' '+request['service']+'\n')
if os.environ.get('NATIVE_FIXTURE_REFUSE')=='1': sys.exit(1)
actual={'id':pathlib.Path(os.environ['NATIVE_FIXTURE_STATE']).read_text(),'service':request['service']}
if request['action']=='verify' and json.loads(request['expected'])!=actual: sys.exit(1)
print(json.dumps(actual))
PY
cat > "$TMPROOT/materialize" <<'SH'
#!/usr/bin/env bash
printf '%s\n' materialize >> "$NATIVE_FIXTURE_LOG"
if [[ "${NATIVE_FIXTURE_RESTART:-0}" == 1 ]]; then printf '%s' restarted > "$NATIVE_FIXTURE_STATE"; fi
exit "${NATIVE_FIXTURE_MATERIALIZE_RC:-0}"
SH
cat > "$TMPROOT/reconcile" <<'SH'
#!/usr/bin/env bash
# The direct reconciler must reuse the runner's baseline before any DML.
. "$NATIVE_FIXTURE_REPO/scripts/ci/lib/lane-db-residency.sh"
. "$NATIVE_FIXTURE_REPO/scripts/ci/lib/preserve-shared-native.sh"
REPO_ROOT="$NATIVE_FIXTURE_REPO"
DEPLOY_ENVIRONMENT="$1" TARGET_NODE="$2"
native_preservation_begin || exit 1
printf '%s\n' reconcile >> "$NATIVE_FIXTURE_LOG"
SH
cat > "$TMPROOT/assert" <<'SH'
#!/usr/bin/env bash
printf '%s\n' assert >> "$NATIVE_FIXTURE_LOG"
SH
chmod +x "$TMPROOT/ssh" "$TMPROOT/materialize" "$TMPROOT/reconcile" "$TMPROOT/assert"
export COGNI_CATALOG_ROOT="$TMPROOT/catalog" FLEET_CONTROL_ENV=production
export FORK_DOMAIN_ROOT=cognidao.org COGNI_DOMAIN_ROOT=cognidao.org COGNI_DEPLOYMENT_SLUG=cogni
export DEPLOYMENT_PROVIDER=akash VM_HOST=production.fixture DOMAIN=test.cognidao.org
export RECONCILE_NODE_SUBSTRATE_SSH_BIN="$TMPROOT/ssh" NATIVE_FIXTURE_REPO="$REPO_ROOT"
export RUN_NODE_SUBSTRATE_MATERIALIZE_BIN="$TMPROOT/materialize" RUN_NODE_SUBSTRATE_RECONCILE_BIN="$TMPROOT/reconcile" RUN_NODE_SUBSTRATE_ASSERT_BIN="$TMPROOT/assert"
unset SUBSTRATE_NATIVE_BASELINE_DIR
: > "$NATIVE_FIXTURE_LOG"
bash "$REPO_ROOT/scripts/ci/run-node-substrate.sh" candidate-a node-template >/dev/null
[[ "$(head -4 "$NATIVE_FIXTURE_LOG" | paste -sd'|' -)" == 'capture both|capture postgres|verify both|verify postgres' ]]
[[ "$(sed -n '5p' "$NATIVE_FIXTURE_LOG")" == materialize ]]
[[ "$(sed -n '6,8p' "$NATIVE_FIXTURE_LOG" | paste -sd'|' -)" == 'verify both|verify postgres|reconcile' ]]
[[ "$(tail -2 "$NATIVE_FIXTURE_LOG" | paste -sd'|' -)" == 'verify both|verify postgres' ]]

: > "$NATIVE_FIXTURE_LOG"
if NATIVE_FIXTURE_REFUSE=1 bash "$REPO_ROOT/scripts/ci/run-node-substrate.sh" candidate-a node-template > "$TMPROOT/refused" 2>&1; then exit 1; fi
! grep -q '^materialize$' "$NATIVE_FIXTURE_LOG"

: > "$NATIVE_FIXTURE_LOG"
if NATIVE_FIXTURE_RESTART=1 bash "$REPO_ROOT/scripts/ci/run-node-substrate.sh" candidate-a node-template > "$TMPROOT/restarted" 2>&1; then exit 1; fi
! grep -q '^reconcile$' "$NATIVE_FIXTURE_LOG"
[[ "$(tail -1 "$NATIVE_FIXTURE_LOG")" == 'verify both' ]]
printf '%s' initial > "$NATIVE_FIXTURE_STATE"

: > "$NATIVE_FIXTURE_LOG"
if NATIVE_FIXTURE_MATERIALIZE_RC=7 bash "$REPO_ROOT/scripts/ci/run-node-substrate.sh" candidate-a node-template > "$TMPROOT/materialize-error" 2>&1; then exit 1; fi
[[ "$(tail -2 "$NATIVE_FIXTURE_LOG" | paste -sd'|' -)" == 'verify both|verify postgres' ]]
! grep -q '^reconcile$' "$NATIVE_FIXTURE_LOG"
# Omission uses the actual Akash declaration; an explicit k3s mismatch refuses.
: > "$NATIVE_FIXTURE_LOG"
env -u DEPLOYMENT_PROVIDER bash "$REPO_ROOT/scripts/ci/run-node-substrate.sh" candidate-a node-template >/dev/null
[[ "$(head -1 "$NATIVE_FIXTURE_LOG")" == 'capture both' ]]
: > "$NATIVE_FIXTURE_LOG"
if DEPLOYMENT_PROVIDER=k3s bash "$REPO_ROOT/scripts/ci/run-node-substrate.sh" candidate-a node-template > "$TMPROOT/mismatched-runner" 2>&1; then exit 1; fi
[[ ! -s "$NATIVE_FIXTURE_LOG" ]]
: > "$NATIVE_FIXTURE_LOG"
if env -u DEPLOYMENT_PROVIDER NATIVE_FIXTURE_REFUSE=1 bash "$REPO_ROOT/scripts/ci/reconcile-node-substrate.sh" candidate-a node-template > "$TMPROOT/default-direct" 2>&1; then exit 1; fi
[[ "$(head -1 "$NATIVE_FIXTURE_LOG")" == 'capture both' ]]
: > "$NATIVE_FIXTURE_LOG"
if DEPLOYMENT_PROVIDER=k3s bash "$REPO_ROOT/scripts/ci/reconcile-node-substrate.sh" candidate-a node-template > "$TMPROOT/mismatched-direct" 2>&1; then exit 1; fi
[[ ! -s "$NATIVE_FIXTURE_LOG" ]]

# A last EXIT-boundary failure must replace an already-written success receipt.
if (
  for function in append_row write_summary cleanup; do
    definition="$(python3 - "$REPO_ROOT/scripts/ci/reconcile-node-substrate.sh" "$function" <<'PY_FUNCTION'
import pathlib,sys
source=pathlib.Path(sys.argv[1]).read_text()
start=source.index(sys.argv[2]+'() {')
end=source.index('\n}\n\n',start)+2
print(source[start:end])
PY_FUNCTION
)"
    eval "$definition"
  done
  TARGET_NODE=node-template DEPLOY_ENVIRONMENT=candidate-a
  SUMMARY_FILE="$TMPROOT/summary.json" ROWS_FILE="$TMPROOT/rows.jsonl" SUMMARY_WRITTEN=false
  : > "$ROWS_FILE"
  native_preservation_finish() { return 1; }
  trap cleanup EXIT
  write_summary success
); then echo 'final preservation failure returned success' >&2; exit 1; fi
python3 - "$TMPROOT/summary.json" <<'PY_VERIFY'
import json,sys
receipt=json.load(open(sys.argv[1]))
assert receipt['status']=='failure'
assert 'native_preservation' in receipt['failed_rows']
assert receipt['rows'][-1]['error_code']=='native_preservation_failed'
PY_VERIFY

python3 "$REPO_ROOT/scripts/ci/tests/preserve-shared-native.test.py"
echo 'template-native-preservation: preflight ordering, inherited baseline and failure/restart refusal pass'
