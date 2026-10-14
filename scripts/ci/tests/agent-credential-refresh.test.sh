#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
REFRESH="$REPO_ROOT/scripts/agent/refresh-agent-credential.sh"
FIXTURE="$(mktemp -d)"
trap 'rm -rf "$FIXTURE"' EXIT

fail() {
  echo "agent-credential-refresh.test: $*" >&2
  exit 1
}

mkdir -p "$FIXTURE/bin" "$FIXTURE/primary" "$FIXTURE/worktree"
cat >"$FIXTURE/bin/curl" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
output=""
method="GET"
auth=""
url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    -X) method="$2"; shift 2 ;;
    -H)
      [[ "$2" == Authorization:* ]] && auth="${2#Authorization: Bearer }"
      shift 2
      ;;
    -d | --max-time | -w) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s %s %s\n' "$method" "$url" "$auth" >>"$FAKE_CALLS"
case "$url" in
  */agent/credentials/status)
    if [[ "$auth" == cogni_ag_sk_v2_revoked.secret ]]; then
      printf '%s' '{"error":"invalid_token"}' >"$output"
      printf '401'
    else
      printf '%s' '{"credentialId":"11111111-1111-4111-8111-111111111111","authenticateUntil":"2026-10-10T00:00:00.000Z"}' >"$output"
      printf '200'
    fi
    ;;
  */agent/credentials/rotate)
    printf '%s' '{"apiKey":"cogni_ag_sk_v2_22222222-2222-4222-8222-222222222222.pending"}' >"$output"
    printf '200'
    ;;
  */agent/credentials/confirm)
    if [[ "${FAKE_CONFIRM_FAIL:-0}" == 1 ]]; then
      printf '%s' '{"error":"unavailable"}' >"$output"
      printf '503'
    else
      printf '%s' '{"status":"active"}' >"$output"
      printf '200'
    fi
    ;;
  */agent/upgrade)
    printf '%s' '{"apiKey":"cogni_ag_sk_v2_33333333-3333-4333-8333-333333333333.upgraded"}' >"$output"
    printf '201'
    ;;
  *)
    printf '%s' '{"error":"unexpected"}' >"$output"
    printf '500'
    ;;
esac
SH
chmod +x "$FIXTURE/bin/curl"
export PATH="$FIXTURE/bin:$PATH"
export FAKE_CALLS="$FIXTURE/calls"
export COGNI_AGENT_ROTATE_BEFORE_SECONDS=315360000

ENV_TARGET="$FIXTURE/primary/.env.cogni"
ENV_LINK="$FIXTURE/worktree/.env.cogni"
printf '%s\n' 'KEEP_ME=yes' 'COGNI_NODE_API_KEY=cogni_ag_sk_v2_11111111-1111-4111-8111-111111111111.active' >"$ENV_TARGET"
ln -s "$ENV_TARGET" "$ENV_LINK"

FAKE_CONFIRM_FAIL=1 bash "$REFRESH" "$ENV_LINK" https://node.example/api/v1
grep -Fq 'COGNI_NODE_API_KEY=cogni_ag_sk_v2_11111111-1111-4111-8111-111111111111.active' "$ENV_TARGET" ||
  fail "predecessor was not preserved after confirm failure"
grep -Fq 'COGNI_NODE_API_KEY_PENDING=cogni_ag_sk_v2_22222222-2222-4222-8222-222222222222.pending' "$ENV_TARGET" ||
  fail "pending crash-recovery slot was not persisted"
grep -Fq 'KEEP_ME=yes' "$ENV_TARGET" || fail "unrelated environment values were lost"

FAKE_CONFIRM_FAIL=0 bash "$REFRESH" "$ENV_LINK" https://node.example/api/v1
grep -Fq 'COGNI_NODE_API_KEY=cogni_ag_sk_v2_22222222-2222-4222-8222-222222222222.pending' "$ENV_TARGET" ||
  fail "confirmed credential was not promoted"
if grep -Fq 'COGNI_NODE_API_KEY_PENDING=' "$ENV_TARGET"; then
  fail "pending slot remained after confirmation"
fi

: >"$FAKE_CALLS"
printf '%s\n' 'COGNI_NODE_API_KEY=cogni_ag_sk_v2_revoked.secret' >"$ENV_TARGET"
bash "$REFRESH" "$ENV_LINK" https://node.example/api/v1
[[ "$(cat "$ENV_TARGET")" == 'COGNI_NODE_API_KEY=cogni_ag_sk_v2_revoked.secret' ]] ||
  fail "401 replaced or altered the rejected credential"
if grep -Fq '/agent/register' "$FAKE_CALLS"; then
  fail "401 triggered anonymous re-registration"
fi

printf '%s\n' 'COGNI_NODE_API_KEY=cogni_ag_sk_v1_legacy' >"$ENV_TARGET"
bash "$REFRESH" "$ENV_LINK" https://node.example/api/v1
grep -Fq 'COGNI_NODE_API_KEY=cogni_ag_sk_v2_33333333-3333-4333-8333-333333333333.upgraded' "$ENV_TARGET" ||
  fail "legacy upgrade was not installed"

mode="$(stat -f '%Lp' "$ENV_TARGET" 2>/dev/null || stat -c '%a' "$ENV_TARGET")"
[[ "$mode" == 600 ]] || fail "credential file mode is $mode, expected 600"

echo "agent-credential-refresh.test: PASS"
