#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Proves the env-substrate reconcile's acceptance contract with fake ssh/kubectl:
#   - absent db-provisioner / openbao-writer SAs are CREATED (non-destructive add);
#   - the per-env roles (writer / db-reader) + eso-reader bind via kubernetes auth;
#   - the writer role binds BOTH openbao-writer AND openbao-operator (additive rename);
#   - a RE-RUN creates NO SA (idempotent no-op) — the manager's prod acceptance.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SUT="$REPO_ROOT/scripts/setup/reconcile-env-substrate.sh"

TMPROOT=$(mktemp -d -t reconcile-env-substrate.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
FAKEBIN="$TMPROOT/bin"
mkdir -p "$FAKEBIN"
SA_STATE="$TMPROOT/sa-state"          # one line per existing SA (persists across runs)
: > "$SA_STATE"

# Fake ssh: run the remote command locally with our fakes on PATH. scp handled too.
cat > "$FAKEBIN/ssh" <<EOF
#!/usr/bin/env bash
while [ "\$#" -gt 0 ] && [[ "\$1" == -* ]]; do case "\$1" in -i|-o) shift 2;; *) shift;; esac; done
[ "\$#" -gt 0 ] && shift   # root@host
PATH="$FAKEBIN:\$PATH" SA_STATE="$SA_STATE" CMDLOG="$TMPROOT/cmd.log" bash -c "\$*"
EOF
chmod +x "$FAKEBIN/ssh"
cat > "$FAKEBIN/scp" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKEBIN/scp"

cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "kubectl $*" >> "$CMDLOG"
# get sa <name> -n default  → exit 0 if recorded as existing, else 1
if [ "$1" = "get" ] && [ "$2" = "sa" ]; then
  grep -qx "$3" "$SA_STATE" && exit 0 || exit 1
fi
if [ "$1" = "create" ] && [ "$2" = "sa" ]; then
  echo "$3" >> "$SA_STATE"; exit 0
fi
if [ "$1" = "apply" ]; then exit 0; fi
if [ "$1" = "exec" ]; then
  # Everything after the literal `bao` is the bao subcommand.
  bao_args="${*#*-- }"; bao_args="${bao_args#* bao }"
  printf '%s\n' "bao $bao_args" >> "$CMDLOG"
  case "$bao_args" in
    "secrets list"*|"auth list"*) echo '{}' ;;   # nothing enabled → exercise enable path
    "policy write"*) cat >/dev/null ;;            # consume HCL on stdin
  esac
  exit 0
fi
exit 0
EOF
chmod +x "$FAKEBIN/kubectl"

run() {
  : > "$TMPROOT/cmd.log"
  env VM_IP=fake GH_REPO=Cogni-DAO/cogni \
    SSH_OPTS="-o StrictHostKeyChecking=no" OPENBAO_ROOT_TOKEN=fake-root \
    PATH="$FAKEBIN:$PATH" \
    bash "$SUT" production >/dev/null 2>&1
}

# ── Run 1: fresh env (no SAs) — must CREATE both SAs + bind all roles ─────────
run
log1="$TMPROOT/cmd.log"; cp "$log1" "$TMPROOT/run1.log"
grep -q "kubectl create sa db-provisioner" "$TMPROOT/run1.log" || { echo "run1 must create db-provisioner SA" >&2; exit 1; }
grep -q "kubectl create sa openbao-writer" "$TMPROOT/run1.log" || { echo "run1 must create openbao-writer SA (rename)" >&2; exit 1; }
grep -q "bao write auth/kubernetes/role/production-db-reader" "$TMPROOT/run1.log" || { echo "run1 must bind production-db-reader role" >&2; exit 1; }
grep -q "bao write auth/kubernetes/role/production-writer .*bound_service_account_names=openbao-writer,openbao-operator" "$TMPROOT/run1.log" || { echo "writer role must bind BOTH SAs (additive rename)" >&2; exit 1; }
grep -q "bao write auth/kubernetes/role/eso-reader" "$TMPROOT/run1.log" || { echo "run1 must bind eso-reader" >&2; exit 1; }
grep -q "bao write auth/github-actions/role/gha-production-writer" "$TMPROOT/run1.log" || { echo "run1 must bind gha-production-writer" >&2; exit 1; }

# ── Run 2: re-run against the now-provisioned env — NO SA creates (idempotent) ─
run
if grep -q "kubectl create sa" "$TMPROOT/cmd.log"; then
  echo "re-run must create ZERO SAs (idempotent); got:" >&2
  grep "kubectl create sa" "$TMPROOT/cmd.log" >&2; exit 1
fi
# roles still upserted on re-run (that is the desired reconcile, harmless)
grep -q "bao write auth/kubernetes/role/production-db-reader" "$TMPROOT/cmd.log" || { echo "re-run should still upsert roles" >&2; exit 1; }

echo "PASS: reconcile-env-substrate.test.sh"
