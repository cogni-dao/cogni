#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Proves the born-observable reconcile's acceptance contract with fake
# ssh/rsync/kubectl/docker (no network, no real VM):
#   Gap 1 — the Alloy runtime configs are rsynced to the VM, alloy is checksum-
#           restarted, and the node-label stage is asserted present post-push.
#   Gap 2 — with a root token + a _shared mint, GRAFANA_URL +
#           GRAFANA_SERVICE_ACCOUNT_TOKEN are SEEDED to cogni/<env>/operator
#           (mirror), and the operator ExternalSecret is force-refreshed.
#   Gap 2 idempotency — when operator already carries non-empty values and no
#           explicit override is given, NO re-seed write happens (0 churn).
#   No-token path — Gap 2 is SKIPPED (no kv writes to operator) but Gap 1 still
#           runs.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SUT="$REPO_ROOT/scripts/setup/reconcile-observability.sh"

TMPROOT=$(mktemp -d -t reconcile-observability.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT
FAKEBIN="$TMPROOT/bin"
mkdir -p "$FAKEBIN"
CMDLOG="$TMPROOT/cmd.log"
# Fake OpenBao KV state: lines of "<path>\t<key>=<value>". OPERATOR_HAS_VALUES
# toggles whether cogni/<env>/operator already carries the two keys.
KV_STATE="$TMPROOT/kv-state"
: > "$KV_STATE"

# Fake ssh: run the remote command locally with our fakes on PATH. Also services
# `ssh ... true` (the preflight probe) and `ssh ... bash -s` (heredoc on stdin).
cat > "$FAKEBIN/ssh" <<EOF
#!/usr/bin/env bash
while [ "\$#" -gt 0 ] && [[ "\$1" == -* ]]; do case "\$1" in -i|-o) shift 2;; *) shift;; esac; done
[ "\$#" -gt 0 ] && shift   # root@host
if [ "\$#" -eq 1 ] && [ "\$1" = "true" ]; then exit 0; fi
PATH="$FAKEBIN:\$PATH" KV_STATE="$KV_STATE" CMDLOG="$CMDLOG" bash -c "\$*"
EOF
chmod +x "$FAKEBIN/ssh"

cat > "$FAKEBIN/rsync" <<EOF
#!/usr/bin/env bash
printf 'rsync %s\n' "\$*" >> "$CMDLOG"
exit 0
EOF
chmod +x "$FAKEBIN/rsync"

# Fake docker: alloy container is "running" so the verify step passes.
cat > "$FAKEBIN/docker" <<'EOF'
#!/usr/bin/env bash
if [ "$1" = "inspect" ]; then echo true; exit 0; fi
exit 0
EOF
chmod +x "$FAKEBIN/docker"

# Fake mkdir: no-op the script's `mkdir -p /opt/...` / `mkdir -p /var/lib/cogni`
# (the test never touches the real FS). Real `mktemp`d paths are unaffected
# because the SUT only mkdirs absolute system dirs through `remote`.
cat > "$FAKEBIN/mkdir" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
chmod +x "$FAKEBIN/mkdir"

# Fake sha256sum: a stable hash so the alloy checksum-restart gate is exercised
# deterministically (first run "changed", later runs unchanged — both fine here).
cat > "$FAKEBIN/sha256sum" <<'EOF'
#!/usr/bin/env bash
echo "deadbeefcafef00d  $1"
EOF
chmod +x "$FAKEBIN/sha256sum"

# Fake cat: the SUT `cat`s the alloy hash file (/var/lib/cogni/...) which doesn't
# exist in the sandbox → real cat would error under set -euo. Route system paths
# to empty; pass real (mktemp) paths through to the real cat.
REAL_CAT="$(command -v cat)"
cat > "$FAKEBIN/cat" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do case "\$a" in /var/lib/cogni/*|/opt/*) exit 0;; esac; done
exec "$REAL_CAT" "\$@"
EOF
chmod +x "$FAKEBIN/cat"

# Stage the real metrics alloy config where the SUT's `grep -q 'node = ""'`
# verify reads it (/opt/.../configs/...). The fake grep below serves it.
ALLOY_SRC="$REPO_ROOT/infra/compose/runtime/configs/alloy-config.metrics.alloy"
REAL_GREP="$(command -v grep)"
cat > "$FAKEBIN/grep" <<EOF
#!/usr/bin/env bash
# Redirect the SUT's deployed-config assert to the real repo config.
args=("\$@"); last="\${args[\${#args[@]}-1]}"
case "\$last" in
  /opt/cogni-template-runtime/configs/alloy-config.metrics.alloy)
    args[\${#args[@]}-1]="$ALLOY_SRC" ;;
esac
exec "$REAL_GREP" "\${args[@]}"
EOF
chmod +x "$FAKEBIN/grep"

# Fake kubectl: services `exec ... bao kv get/metadata/put` against KV_STATE and
# `get/annotate externalsecret`.
cat > "$FAKEBIN/kubectl" <<'EOF'
#!/usr/bin/env bash
printf 'kubectl %s\n' "$*" >> "$CMDLOG"
case "$1 $2" in
  "get externalsecret")
    # operator-env-secrets exists; env-secrets does not.
    [ "$3" = "operator-env-secrets" ] && exit 0 || exit 1 ;;
  "annotate externalsecret") exit 0 ;;
esac
if [ "$1" = "exec" ]; then
  bao_args="${*#*-- }"; bao_args="${bao_args#* bao }"
  printf 'bao %s\n' "$bao_args" >> "$CMDLOG"
  case "$bao_args" in
    "kv metadata get "*)
      path="${bao_args#kv metadata get }"; path="${path//\'/}"
      grep -q "^${path}	" "$KV_STATE" && exit 0 || exit 1 ;;
    "kv get -format=json "*)
      path="${bao_args#kv get -format=json }"; path="${path//\'/}"
      printf '{"data":{"data":{'
      first=1
      while IFS=$'\t' read -r p kv; do
        [ "$p" = "$path" ] || continue
        k="${kv%%=*}"; v="${kv#*=}"
        [ $first -eq 1 ] || printf ','
        printf '"%s":"%s"' "$k" "$v"; first=0
      done < "$KV_STATE"
      printf '}}}\n'; exit 0 ;;
    "kv put "*|"kv patch "*)
      rest="${bao_args#kv * }"
      path="${rest%% *}"; path="${path//\'/}"
      kveq="${rest#* }"; kveq="${kveq//\'/}"
      key="${kveq%%=*}"
      val="$(cat)"   # value piped on stdin via `=-`
      # drop any prior copy of this path/key, then append
      grep -v "^${path}	${key}=" "$KV_STATE" > "$KV_STATE.tmp" 2>/dev/null || true
      mv "$KV_STATE.tmp" "$KV_STATE"
      printf '%s\t%s=%s\n' "$path" "$key" "$val" >> "$KV_STATE"
      printf 'SEEDED %s %s\n' "$path" "$key" >> "$CMDLOG"
      exit 0 ;;
  esac
fi
exit 0
EOF
chmod +x "$FAKEBIN/kubectl"

run() {
  : > "$CMDLOG"
  env VM_IP=fake \
    SSH_OPTS="-o StrictHostKeyChecking=no" \
    PATH="$FAKEBIN:$PATH" \
    "$@" \
    bash "$SUT" production >/dev/null 2>&1
}

# ── Run 1: token + _shared mint present, operator empty → MIRROR + force-refresh ─
printf 'cogni/production/_shared\tGRAFANA_URL=https://x.grafana.net\n' >> "$KV_STATE"
printf 'cogni/production/_shared\tGRAFANA_SERVICE_ACCOUNT_TOKEN=glsa_abc\n' >> "$KV_STATE"
run OPENBAO_ROOT_TOKEN=fake-root

grep -q "rsync .*infra/compose/runtime/configs/" "$CMDLOG" || { echo "Gap1: must rsync runtime configs" >&2; exit 1; }
grep -q "SEEDED cogni/production/operator GRAFANA_URL" "$CMDLOG" || { echo "Gap2: must seed operator GRAFANA_URL (mirror)" >&2; exit 1; }
grep -q "SEEDED cogni/production/operator GRAFANA_SERVICE_ACCOUNT_TOKEN" "$CMDLOG" || { echo "Gap2: must seed operator token (mirror)" >&2; exit 1; }
grep -q "annotate externalsecret operator-env-secrets force-sync" "$CMDLOG" || { echo "Gap2: must force-refresh operator ExternalSecret" >&2; exit 1; }

# ── Run 2: operator now carries values, no override → 0 churn (no re-seed) ────
run OPENBAO_ROOT_TOKEN=fake-root
if grep -q "SEEDED cogni/production/operator" "$CMDLOG"; then
  echo "Gap2 idempotency: re-run must NOT re-seed operator keys; got:" >&2
  grep "SEEDED cogni/production/operator" "$CMDLOG" >&2; exit 1
fi
grep -q "rsync .*infra/compose/runtime/configs/" "$CMDLOG" || { echo "Gap1 still runs on re-run" >&2; exit 1; }

# ── Run 3: explicit override re-seeds even when operator already has a value ──
run OPENBAO_ROOT_TOKEN=fake-root GRAFANA_URL=https://override.grafana.net
grep -q "SEEDED cogni/production/operator GRAFANA_URL" "$CMDLOG" || { echo "Gap2: explicit override must re-seed GRAFANA_URL" >&2; exit 1; }

# ── Run 4: no root token → Gap 2 SKIPPED (no operator writes), Gap 1 still runs ─
: > "$KV_STATE"
run
if grep -q "SEEDED cogni/production/operator" "$CMDLOG"; then
  echo "no-token path: Gap2 must be SKIPPED (no operator seed); got:" >&2
  grep "SEEDED" "$CMDLOG" >&2; exit 1
fi
grep -q "rsync .*infra/compose/runtime/configs/" "$CMDLOG" || { echo "no-token path: Gap1 must still run" >&2; exit 1; }

echo "PASS: reconcile-observability.test.sh"
