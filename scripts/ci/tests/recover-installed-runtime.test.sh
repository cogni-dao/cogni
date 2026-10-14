#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Proves bug.5462's custody-free recovery boundary: exact receipt match starts
# only postgres -> LiteLLM -> autoheal with local images; missing/tampered state
# returns custody_required without a Compose mutation; sealed OpenBao is degraded.
# Candidate full reconcile invokes the same preflight before custody rendering.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$REPO_ROOT"

TMPROOT="$(mktemp -d -t recover-installed-runtime.XXXXXX)"
cleanup() {
  cleanup_rc=$?
  rm -rf "$TMPROOT"
  trap - EXIT
  exit "$cleanup_rc"
}
trap cleanup EXIT
FAKEBIN="$TMPROOT/bin"
RUNTIME_DIR="$TMPROOT/runtime"
RECEIPT="$TMPROOT/runtime-recovery-receipt.json"
DOCKER_LOG="$TMPROOT/docker.log"
mkdir -p "$FAKEBIN" "$RUNTIME_DIR/configs"
: > "$DOCKER_LOG"

# Exercise the exact classifier embedded in deploy-infra's remote script. GNU
# timeout may return 124 with empty stderr; that is bounded/transient, while a
# stable permission denial and an unknown failure retain their narrow classes.
classifier="$(awk '
  /^classify_openbao_writer_login_failure\(\) \{/ { capture=1 }
  capture { print }
  capture && /^}$/ { exit }
' scripts/ci/deploy-infra.sh)"
[[ -n "$classifier" ]] || { echo "OpenBao writer login classifier not found" >&2; exit 1; }
eval "$classifier"
[[ "$(classify_openbao_writer_login_failure 124 '')" == server_transient ]]
[[ "$(classify_openbao_writer_login_failure 2 'Code: 403. permission denied')" == permission_denied_recheck ]]
[[ "$(classify_openbao_writer_login_failure 7 'malformed role')" == permanent ]]

# A timed-out Kubernetes API lookup is not proof that the service account is
# absent. Only an explicit NotFound may produce that diagnosis; unknown failures
# remain fail-closed without inventing state.
lookup_classifier="$(awk '
  /^classify_kubectl_resource_lookup_failure\(\) \{/ { capture=1 }
  capture { print }
  capture && /^}$/ { exit }
' scripts/ci/deploy-infra.sh)"
[[ -n "$lookup_classifier" ]] || { echo "kubectl resource lookup classifier not found" >&2; exit 1; }
eval "$lookup_classifier"
[[ "$(classify_kubectl_resource_lookup_failure 124 '')" == server_transient ]]
[[ "$(classify_kubectl_resource_lookup_failure 1 'Error from server (NotFound): serviceaccounts \"openbao-operator\" not found')" == absent ]]
[[ "$(classify_kubectl_resource_lookup_failure 1 'forbidden')" == permanent ]]

printf 'services: {}\n' > "$RUNTIME_DIR/docker-compose.yml"
printf 'LITELLM_MASTER_KEY=test-only\n' > "$RUNTIME_DIR/.env"
printf 'model_list: []\n' > "$RUNTIME_DIR/configs/litellm.config.yaml"

cat > "$FAKEBIN/ssh" <<'EOF'
#!/usr/bin/env bash
while [[ $# -gt 0 && "$1" == -* ]]; do
  case "$1" in
    -i|-o) shift 2 ;;
    *) shift ;;
  esac
done
[[ $# -gt 0 ]] && shift
exec bash -c "$*"
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/docker" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$*" == *"config --format json"* ]]; then
  master_key="$(awk -F= '/^LITELLM_MASTER_KEY=/ {print substr($0, index($0, "=") + 1)}' "$FAKE_RUNTIME_DIR/.env" | tail -1)"
  jq -cn --arg master_key "$master_key" \
    '{services:{postgres:{image:"postgres:17"},litellm:{image:"litellm:test",environment:{LITELLM_MASTER_KEY:$master_key}},autoheal:{image:"autoheal:test"}}}'
  exit 0
fi
if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  ref="${@: -1}"
  case "$ref" in
    postgres:17) printf 'sha256:postgres\n' ;;
    litellm:test) printf 'sha256:litellm\n' ;;
    autoheal:test) printf 'sha256:autoheal\n' ;;
    *) exit 1 ;;
  esac
  exit 0
fi
if [[ "$*" == *" up -d "* ]]; then
  exit 0
fi
if [[ "$*" == *" ps -q "* ]]; then
  printf 'cid-%s\n' "${@: -1}"
  exit 0
fi
if [[ "${1:-}" == inspect ]]; then
  printf 'healthy\n'
  exit 0
fi
echo "unexpected docker invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKEBIN/docker"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
if [[ "${FAKE_OPENBAO_SEALED:-false}" == true ]]; then
  printf '{"sealed":true}\n'
  exit 2
fi
printf '{"sealed":false}\n'
EOF
chmod +x "$FAKEBIN/kubectl"

cat > "$FAKEBIN/timeout" <<'EOF'
#!/usr/bin/env bash
shift
exec "$@"
EOF
chmod +x "$FAKEBIN/timeout"

write_receipt() {
  local compose_sha config_sha recovery_service_config recovery_service_config_sha core digest master_key
  compose_sha="$(sha256sum "$RUNTIME_DIR/docker-compose.yml" | awk '{print $1}')"
  config_sha="$(sha256sum "$RUNTIME_DIR/configs/litellm.config.yaml" | awk '{print $1}')"
  master_key="$(awk -F= '/^LITELLM_MASTER_KEY=/ {print substr($0, index($0, "=") + 1)}' "$RUNTIME_DIR/.env" | tail -1)"
  recovery_service_config="$(jq -cnS --arg master_key "$master_key" \
    '{services:{postgres:{image:"postgres:17"},litellm:{image:"litellm:test",environment:{LITELLM_MASTER_KEY:$master_key}},autoheal:{image:"autoheal:test"}}}')"
  recovery_service_config_sha="$(printf '%s' "$recovery_service_config" | sha256sum | awk '{print $1}')"
  core="$(jq -cnS \
    --arg compose "$compose_sha" \
    --arg config "$config_sha" \
    --arg recoveryServiceConfig "$recovery_service_config_sha" \
    '{version:2,composeSha256:$compose,litellmConfigSha256:$config,recoveryServiceConfigSha256:$recoveryServiceConfig,images:{postgres:{ref:"postgres:17",id:"sha256:postgres"},litellm:{ref:"litellm:test",id:"sha256:litellm"},autoheal:{ref:"autoheal:test",id:"sha256:autoheal"}},sourceRef:"test",completedAt:"2026-10-14T00:00:00Z"}')"
  digest="$(printf '%s' "$core" | sha256sum | awk '{print $1}')"
  jq -cS --arg digest "$digest" '. + {declarationDigest:$digest}' <<<"$core" > "$RECEIPT"
}

run_recovery() {
  env \
    PATH="$FAKEBIN:$PATH" \
    VM_HOST=fake \
    DEPLOY_ENVIRONMENT=candidate-a \
    COGNI_RUNTIME_DIR="$RUNTIME_DIR" \
    COGNI_RECOVERY_RECEIPT="$RECEIPT" \
    FAKE_DOCKER_LOG="$DOCKER_LOG" \
    FAKE_RUNTIME_DIR="$RUNTIME_DIR" \
    FAKE_OPENBAO_SEALED="${FAKE_OPENBAO_SEALED:-false}" \
    bash scripts/ci/deploy-infra.sh --recover-installed-runtime
}

# Missing receipt: named fail-closed state, no Docker command at all.
missing_out="$(run_recovery)"
grep -q '^recovery_state=custody_required$' <<<"$missing_out"
grep -q '^recovery_reason=receipt_missing$' <<<"$missing_out"
[[ ! -s "$DOCKER_LOG" ]] || { echo "missing receipt mutated Docker" >&2; exit 1; }

# Exact receipt: start only the three declared services, in dependency order,
# with --pull never so recovery cannot change image identity.
write_receipt
: > "$DOCKER_LOG"
recovered_out="$(run_recovery)"
grep -q '^recovery_state=recovered$' <<<"$recovered_out"
mapfile -t up_lines < <(grep ' up -d ' "$DOCKER_LOG")
[[ "${#up_lines[@]}" == 3 ]] || { echo "expected exactly three compose up calls" >&2; cat "$DOCKER_LOG" >&2; exit 1; }
[[ "${up_lines[0]}" == *"--pull never postgres" ]]
[[ "${up_lines[1]}" == *"--pull never litellm" ]]
[[ "${up_lines[2]}" == *"--pull never autoheal" ]]
! grep -Eq '(^| )pull( |$)' "$DOCKER_LOG" || { echo "recovery pulled an image" >&2; exit 1; }

# A node-substrate flight legitimately changes unrelated shared-env projection
# state. That must not invalidate recovery of postgres/LiteLLM/autoheal.
printf 'COGNI_NODE_DBS=cogni_operator\n' >> "$RUNTIME_DIR/.env"
: > "$DOCKER_LOG"
unrelated_out="$(run_recovery)"
grep -q '^recovery_state=recovered$' <<<"$unrelated_out"

# A value consumed by a recovery service is declaration drift and must fail
# before any Compose mutation.
sed -i.bak 's/^LITELLM_MASTER_KEY=.*/LITELLM_MASTER_KEY=changed/' "$RUNTIME_DIR/.env"
: > "$DOCKER_LOG"
tampered_out="$(run_recovery)"
grep -q '^recovery_state=custody_required$' <<<"$tampered_out"
grep -q '^recovery_reason=recovery_service_config_mismatch$' <<<"$tampered_out"
! grep -q ' up -d ' "$DOCKER_LOG" || { echo "tampered receipt mutated Docker" >&2; exit 1; }

# Matching receipt plus sealed custody: availability is restored but surfaced as
# degraded; recovery itself never reads or writes a secret.
write_receipt
: > "$DOCKER_LOG"
FAKE_OPENBAO_SEALED=true
degraded_out="$(run_recovery)"
grep -q '^recovery_state=recovered_degraded$' <<<"$degraded_out"

# The normal candidate-a full-reconcile path shares the recovery preflight. It
# reaches required-secret validation only after attempting installed recovery;
# use a missing receipt so the preflight itself performs zero Docker mutation.
rm -f "$RECEIPT"
: > "$DOCKER_LOG"
set +e
candidate_full_out="$({
  env \
    PATH="$FAKEBIN:$PATH" \
    VM_HOST=fake \
    DEPLOY_ENVIRONMENT=candidate-a \
    COGNI_RUNTIME_DIR="$RUNTIME_DIR" \
    COGNI_RECOVERY_RECEIPT="$RECEIPT" \
    FAKE_DOCKER_LOG="$DOCKER_LOG" \
    FAKE_RUNTIME_DIR="$RUNTIME_DIR" \
    bash scripts/ci/deploy-infra.sh
} 2>&1)"
candidate_full_rc=$?
set -e
[[ "$candidate_full_rc" -ne 0 ]] || { echo "candidate full reconcile unexpectedly passed without required secrets" >&2; exit 1; }
grep -q '^recovery_state=custody_required$' <<<"$candidate_full_out"
grep -q 'Candidate full reconcile continuing after installed-runtime recovery preflight' <<<"$candidate_full_out"
grep -q 'Missing required secret environment variables' <<<"$candidate_full_out"
[[ ! -s "$DOCKER_LOG" ]] || { echo "candidate full preflight mutated Docker without a receipt" >&2; exit 1; }

echo "PASS: recover-installed-runtime.test.sh"
