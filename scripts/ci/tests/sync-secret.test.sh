#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Tests scripts/secrets/sync-secret.sh with a stubbed kubectl ($SYNC_SECRET_KUBECTL).
# Asserts the guards and — the point of the script — that it NEVER prints a value.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SCRIPT="$ROOT/scripts/secrets/sync-secret.sh"
pass=0; fail=0
ok(){ printf '  ok   %s\n' "$1"; pass=$((pass+1)); }
no(){ printf '  FAIL %s\n' "$1"; fail=$((fail+1)); }

stub="$(mktemp)"; chmod +x "$stub"
cat > "$stub" <<'STUB'
#!/usr/bin/env bash
# minimal kubectl stub: one ExternalSecret, one target Secret, one key
args="$*"
case "$args" in
  *"get externalsecret -l"*)      echo "operator-akash-tx-actuator-env-secrets" ;;
  *"annotate externalsecret"*)    echo "annotated" ;;
  *"jsonpath={.spec.target.name}"*) echo "akash-tx-actuator-env-secrets" ;;
  *"go-template"*)                echo "AKASH_ACTUATOR_CONSOLE_API_KEY" ;;
  *"jsonpath={.data.AKASH_ACTUATOR_CONSOLE_API_KEY}"*) printf 'c3VwZXItc2VjcmV0LXZhbHVl' ;;
  *) : ;;
esac
STUB

out="$(SYNC_SECRET_KUBECTL="$stub" bash "$SCRIPT" candidate-a akash-tx-actuator 2>&1)"; rc=$?
[[ $rc -eq 0 ]] && ok "exits 0 on a healthy push" || no "exit $rc"
grep -q "pushed cogni-candidate-a/operator-akash-tx-actuator-env-secrets" <<<"$out" \
  && ok "annotates the labelled ExternalSecret" || no "no push line"
grep -qE "fp=[0-9a-f]{12}" <<<"$out" && ok "reports a 12-hex fingerprint" || no "no fingerprint"

# THE load-bearing assertion: the decoded value is 'super-secret-value'.
grep -q "super-secret-value" <<<"$out" && no "LEAKED the secret value" || ok "never prints the value"

for bad in "nope candidate-a" "candidate-a BadService" "production _shared"; do
  if SYNC_SECRET_KUBECTL="$stub" bash "$SCRIPT" $bad >/dev/null 2>&1; then
    no "accepted invalid args: $bad"
  else ok "rejects invalid args: $bad"; fi
done

empty="$(mktemp)"; chmod +x "$empty"; printf '#!/usr/bin/env bash\nexit 0\n' > "$empty"
if SYNC_SECRET_KUBECTL="$empty" bash "$SCRIPT" candidate-a akash-tx-actuator >/dev/null 2>&1; then
  no "succeeded with zero ExternalSecrets (must fail loudly)"
else ok "fails loudly when nothing matches the selector"; fi

rm -f "$stub" "$empty"
printf '\n%d passed, %d failed\n' "$pass" "$fail"
[[ $fail -eq 0 ]]
