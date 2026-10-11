#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/secrets/sync-app-webhook-secret.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

openssl genrsa -out "$TMP/key.pem" 2048 >/dev/null 2>&1
DESIRED_KEY="$(base64 <"$TMP/key.pem" | tr -d '\n')"
export DESIRED_KEY DESIRED_ID=12345 EXPECTED_HOST=test.cognidao.org

cat >"$TMP/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
out=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ "${CURL_SCENARIO:-valid}" == invalid ]]; then
  printf '{"message":"Bad credentials"}' >"$out"
  printf '401'
elif [[ "$url" == */app/hook/config ]]; then
  host="${HOOK_HOST:-$EXPECTED_HOST}"
  printf '{"url":"https://%s/api/github/webhooks"}' "$host" >"$out"
  printf '200'
else
  printf '{"slug":"cogni-operator-test"}' >"$out"
  printf '200'
fi
SH

cat >"$TMP/kubectl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$KUBECTL_LOG"
args="$*"
case "$args" in
  *"get sa openbao-writer"*) exit 0 ;;
  *"create token openbao-writer"*) printf 'service-account-jwt' ;;
  *"bao write -field=token auth/kubernetes/login"*) printf 'writer-token' ;;
  *"bao kv get -format=json"*)
    printf '{"data":{"data":{"GH_REVIEW_APP_ID":"%s","GH_REVIEW_APP_PRIVATE_KEY_BASE64":"%s"}}}' \
      "${CURRENT_ID:-}" "${CURRENT_KEY:-}"
    ;;
  *"bao kv patch"*)
    value="$(cat)"
    [[ -n "$value" ]]
    ;;
  *"get externalsecret operator-env-secrets"*) exit 0 ;;
  *"annotate externalsecret operator-env-secrets"*) exit 0 ;;
  *"get secret operator-env-secrets"*"GH_REVIEW_APP_ID"*) printf '%s' "$DESIRED_ID" | base64 ;;
  *"get secret operator-env-secrets"*"GH_REVIEW_APP_PRIVATE_KEY_BASE64"*) printf '%s' "$DESIRED_KEY" | base64 ;;
  *) printf 'unexpected kubectl invocation: %s\n' "$args" >&2; exit 1 ;;
esac
SH
chmod +x "$TMP/curl" "$TMP/kubectl"

run_case() {
  local name="$1"
  shift
  : >"$TMP/${name}.kubectl.log"
  env \
    DEPLOY_ENVIRONMENT=candidate-a \
    GH_REVIEW_APP_ID="$DESIRED_ID" \
    GH_REVIEW_APP_PRIVATE_KEY_BASE64="$DESIRED_KEY" \
    EXPECTED_WEBHOOK_HOST="$EXPECTED_HOST" \
    GITHUB_APP_CREDENTIAL_OPERATION=reconcile-openbao \
    RECONCILE_GITHUB_APP_CURL="$TMP/curl" \
    RECONCILE_GITHUB_APP_KUBECTL="$TMP/kubectl" \
    KUBECTL_LOG="$TMP/${name}.kubectl.log" \
    "$@" \
    bash "$SCRIPT" >"$TMP/${name}.out" 2>"$TMP/${name}.err"
}

run_case invalid CURL_SCENARIO=invalid CURRENT_ID=old CURRENT_KEY=old
grep -qx 'GITHUB_APP_CREDENTIAL_STATE=invalid' "$TMP/invalid.out"
! grep -q 'bao kv patch' "$TMP/invalid.kubectl.log"

run_case misbound HOOK_HOST=preview.cognidao.org CURRENT_ID=old CURRENT_KEY=old
grep -qx 'GITHUB_APP_CREDENTIAL_STATE=misbound' "$TMP/misbound.out"
! grep -q 'bao kv patch' "$TMP/misbound.kubectl.log"

run_case current CURRENT_ID="$DESIRED_ID" CURRENT_KEY="$DESIRED_KEY"
grep -qx 'GITHUB_APP_CREDENTIAL_STATE=current' "$TMP/current.out"
! grep -q 'bao kv patch' "$TMP/current.kubectl.log"

run_case rotated CURRENT_ID="$DESIRED_ID" CURRENT_KEY=stale
grep -qx 'GITHUB_APP_CREDENTIAL_STATE=rotated' "$TMP/rotated.out"
[[ "$(grep -c 'bao kv patch' "$TMP/rotated.kubectl.log")" -eq 2 ]]
! grep -Fq "$DESIRED_KEY" "$TMP/rotated.out" "$TMP/rotated.err" "$TMP/rotated.kubectl.log"

printf 'reconcile-github-app-credentials: PASS\n'
