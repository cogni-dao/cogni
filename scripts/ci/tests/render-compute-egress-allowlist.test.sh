#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Module: scripts/ci/tests/render-compute-egress-allowlist.test.sh
# Purpose: Prove the catalog→VM substrate admission path (task.5052, task.5428):
#   1. render-compute-egress-allowlist.sh renders NO provider egress line for any
#      env (task.5428: every lane reaches the substrate over the mesh) and only the
#      native migration custodian /32:5432 for an Akash-placed nonproduction lane
#      (task.5256; PLACEMENT scoping, determinism, fail-loud validation);
#   2. harden-docker-public-ports.sh (faked iptables) installs the staged file
#      and places ACCEPTs ahead of the public DROP;
#   3. idempotency — re-running produces byte-identical rules;
#   4. fail-closed — an empty render yields NO compute ACCEPTs while the public
#      DROP remains, and catalog removal converges on the next run.
#   5. reboot persistence (story.5084) — the hardener installs a current copy of
#      itself plus an enabled docker-bound boot replay unit, idempotently.
# Usage: bash scripts/ci/tests/render-compute-egress-allowlist.test.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
RENDERER="$REPO_ROOT/scripts/ci/render-compute-egress-allowlist.sh"
HARDEN="$REPO_ROOT/infra/provision/cherry/harden-docker-public-ports.sh"

TMPROOT=$(mktemp -d -t render-compute-egress.XXXXXX)
trap 'rm -rf "$TMPROOT"' EXIT

PASS=0
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { PASS=$((PASS + 1)); echo "ok $PASS - $*"; }

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Catalog fixture
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CATALOG="$TMPROOT/catalog"
mkdir -p "$CATALOG"

cat > "$CATALOG/toksa.yaml" <<'EOF'
name: toksa
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: akash
EOF

cat > "$CATALOG/toksb.yaml" <<'EOF'
name: toksb
type: node
envs: [preview]
deployment_provider:
  preview: akash
EOF

cat > "$CATALOG/toksdup.yaml" <<'EOF'
name: toksdup
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: akash
EOF

# bug.5191 — PLACEMENT, not membership. Explicit k3s in the only env it deploys
# to: this row must never earn a migration custodian grant.
cat > "$CATALOG/toksk3s.yaml" <<'EOF'
name: toksk3s
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: k3s
EOF

# bug.5191 — the same row in TWO envs with different placement. K3S_IS_DEFAULT:
# candidate-a has no override, so it is k3s and contributes nothing there; preview
# is akash. One row, opposite placements per env.
cat > "$CATALOG/tokssplit.yaml" <<'EOF'
name: tokssplit
type: node
envs: [candidate-a, preview]
deployment_provider:
  preview: akash
EOF

# Rows without placement / without envs must contribute nothing.
cat > "$CATALOG/plain.yaml" <<'EOF'
name: plain
type: node
envs: [candidate-a, preview]
EOF
cat > "$CATALOG/infraonly.yaml" <<'EOF'
name: infraonly
type: infra
EOF

export COGNI_CATALOG_ROOT="$CATALOG"
# The isolated-fleet cases have no production custodian and no implicit
# DNS/domain authority.
export FLEET_CONTROL_ENV=candidate-a
unset FORK_DOMAIN_ROOT COGNI_DOMAIN_ROOT COGNI_DEPLOYMENT_SLUG
PORTS="5432,5435,6379,4000,7233"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. Renderer: no provider egress line in any env (task.5428)
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUT_A="$TMPROOT/candidate-a.list"
bash "$RENDERER" candidate-a > "$OUT_A"
OUT_P="$TMPROOT/preview.list"
bash "$RENDERER" preview > "$OUT_P"
for out in "$OUT_A" "$OUT_P"; do
  if grep -qv '^#' "$out"; then
    cat "$out" >&2
    fail "isolated fleet rendered an allow line ($(basename "$out"))"
  fi
done
ok "Akash-placed rows render no provider egress line in any env (mesh carries the substrate)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. Renderer: empty env + idempotency + fail-loud validation
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUT_PROD="$TMPROOT/production.list"
bash "$RENDERER" production > "$OUT_PROD"
if grep -qv '^#' "$OUT_PROD"; then
  fail "production must render zero allow lines"
fi
ok "env with no external compute renders an allow-free (fail-closed) file"

bash "$RENDERER" candidate-a > "$TMPROOT/candidate-a.second"
diff -u "$OUT_A" "$TMPROOT/candidate-a.second" || fail "renderer is not deterministic"
ok "renderer is deterministic/idempotent"

# An unresolvable placement must abort, never silently fall through to "not akash"
# (that would turn a catalog typo into a quiet, unnoticed firewall change).
cat > "$CATALOG/badplacement.yaml" <<'EOF'
name: badplacement
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: fly
EOF
if bash "$RENDERER" candidate-a > /dev/null 2>&1; then
  fail "renderer must fail LOUD on an unsupported deployment_provider"
fi
rm "$CATALOG/badplacement.yaml"
ok "unsupported deployment_provider aborts the render"

# Native migration custody: hermetic DNS, no production/fork network lookups.
DNSBIN="$TMPROOT/dns-bin"
mkdir -p "$DNSBIN"
cat > "$DNSBIN/getent" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$2" >> "$DNS_QUERY_LOG"
[ "$1" = ahostsv4 ] && [ "$2" = "$FAKE_EXPECTED_ALIAS" ] || exit 1
printf '%s\n' "${FAKE_MIGRATION_IPS-198.51.100.23}"
EOF
for tool in dig python3; do
  printf '#!/usr/bin/env bash\nexit 1\n' > "$DNSBIN/$tool"
done
chmod +x "$DNSBIN/"*
export DNS_QUERY_LOG="$TMPROOT/dns-queries"
: > "$DNS_QUERY_LOG"
MIGRATION_ENV=(
  PATH="$DNSBIN:$PATH"
  FLEET_CONTROL_ENV=production
  FORK_DOMAIN_ROOT=migration.fixture.test
  FAKE_EXPECTED_ALIAS=cogni.vm.migration.fixture.test
)
OUT_MIGRATION="$TMPROOT/candidate-migration.list"
env "${MIGRATION_ENV[@]}" bash "$RENDERER" candidate-a > "$OUT_MIGRATION"
grep -Fxq '198.51.100.23/32:5432' "$OUT_MIGRATION" || fail "missing migration control /32:5432"
[ "$(grep -Fc '198.51.100.23/32:5432' "$OUT_MIGRATION")" = 1 ] || fail "migration rule duplicated across rows"
[ "$(grep -v '^#' "$OUT_MIGRATION")" = '198.51.100.23/32:5432' ] || fail "custodian render carries a non-custodian rule"
ok "foreign nonproduction lanes render exactly one custodian /32:5432 and nothing else"

env "${MIGRATION_ENV[@]}" bash "$RENDERER" preview > "$TMPROOT/preview-migration.list"
grep -Fxq '198.51.100.23/32:5432' "$TMPROOT/preview-migration.list" || fail "preview migration control missing"
ok "preview owner Postgres admits only the production migration custodian"

env "${MIGRATION_ENV[@]}" COGNI_DEPLOYMENT_SLUG=forkfleet FORK_DOMAIN_ROOT=fork.fixture.test \
  FAKE_EXPECTED_ALIAS=forkfleet.vm.fork.fixture.test \
  bash "$RENDERER" candidate-a > "$TMPROOT/fork-migration.list"
grep -q '^# migration custodian: forkfleet.vm.fork.fixture.test ' "$TMPROOT/fork-migration.list" \
  || fail "fork control alias did not use explicit fork identity"
ok "foreign fork custody resolves only its explicit fork domain and deployment slug"

for target_env in production candidate-b; do
  : > "$DNS_QUERY_LOG"
  env "${MIGRATION_ENV[@]}" bash "$RENDERER" "$target_env" > "$TMPROOT/no-migration.list"
  grep -q '^198.51.100.23/' "$TMPROOT/no-migration.list" && fail "migration admission leaked into $target_env"
  [ ! -s "$DNS_QUERY_LOG" ] || fail "unrelated/production env performed foreign DNS"
done
ok "production and unrelated envs never admit or resolve migration control"

: > "$DNS_QUERY_LOG"
env "${MIGRATION_ENV[@]}" FLEET_CONTROL_ENV=candidate-a bash "$RENDERER" candidate-a > "$TMPROOT/isolated.list"
diff -u "$OUT_A" "$TMPROOT/isolated.list" || fail "isolated fleet gained foreign trust"
[ ! -s "$DNS_QUERY_LOG" ] || fail "isolated fleet resolved a production host"
env "${MIGRATION_ENV[@]}" FLEET_CONTROL_ENV=preview bash "$RENDERER" candidate-a > "$TMPROOT/uptrust.list"
grep -q '^198.51.100.23/' "$TMPROOT/uptrust.list" && fail "nonproduction control gained uptrust admission"
ok "self-control and nonproduction control grant no cross-environment admission"

: > "$DNS_QUERY_LOG"
env "${MIGRATION_ENV[@]}" FORK_DOMAIN_ROOT= \
  bash "$RENDERER" candidate-a production > "$TMPROOT/control-twin.list"
diff -u <(sed '/^# env:/d' "$OUT_A") <(sed '/^# env:/d' "$TMPROOT/control-twin.list") \
  || fail "control-host twin gained a migration rule"
grep -q '^# env: production ' "$TMPROOT/control-twin.list" || fail "allowlist names the caller instead of its destination"
[ ! -s "$DNS_QUERY_LOG" ] || fail "control-host twin resolved foreign migration trust"
ok "actual production control-host twin renders NO custodian/self admission"

if env "${MIGRATION_ENV[@]}" FORK_DOMAIN_ROOT= bash "$RENDERER" candidate-a > /dev/null 2> "$TMPROOT/no-root.err"; then
  fail "foreign custody accepted a defaulted domain root"
fi
grep -q 'explicit FORK_DOMAIN_ROOT is required' "$TMPROOT/no-root.err" || fail "missing root failed for wrong reason"
ok "foreign migration custody fails closed without explicit fleet domain"

for address in '' '198.51.100.23
198.51.100.24' 127.0.0.1 0.0.0.0 255.255.255.255 224.0.0.1 999.1.1.1 malformed; do
  if env "${MIGRATION_ENV[@]}" FAKE_MIGRATION_IPS="$address" bash "$RENDERER" candidate-a > /dev/null 2>&1; then
    fail "unsafe/missing/ambiguous custodian IPv4 accepted: $address"
  fi
done
ok "missing, ambiguous, loopback, unspecified, broadcast, multicast, and malformed IPv4 fail closed"

MIGRATION_ONLY_CATALOG="$TMPROOT/migration-only-catalog"
mkdir -p "$MIGRATION_ONLY_CATALOG"
cat > "$MIGRATION_ONLY_CATALOG/only.yaml" <<'EOF'
name: only
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: akash
EOF
env "${MIGRATION_ENV[@]}" COGNI_CATALOG_ROOT="$MIGRATION_ONLY_CATALOG" \
  bash "$RENDERER" candidate-a > "$TMPROOT/migration-only.list"
[ "$(grep -v '^#' "$TMPROOT/migration-only.list")" = '198.51.100.23/32:5432' ] \
  || fail "native migration admission missing for a foreign Akash lane"
ok "an actual foreign Akash lane gets migration admission from placement alone"
yq -i '.deployment_provider."candidate-a" = "k3s"' "$MIGRATION_ONLY_CATALOG/only.yaml"
: > "$DNS_QUERY_LOG"
env "${MIGRATION_ENV[@]}" COGNI_CATALOG_ROOT="$MIGRATION_ONLY_CATALOG" \
  bash "$RENDERER" candidate-a > "$TMPROOT/k3s-only.list"
grep -qv '^#' "$TMPROOT/k3s-only.list" && fail "k3s-only lane gained migration admission"
[ ! -s "$DNS_QUERY_LOG" ] || fail "k3s-only lane performed foreign DNS"
ok "a k3s-only lane resolves and admits no foreign migration control"

# App delivery cannot replace the shared VM policy from an old app catalog.
[ ! -f "$REPO_ROOT/.github/actions/reconcile-compute-egress/action.yml" ] \
  || fail "ordinary app firewall action must be removed"
for workflow in candidate-flight.yml promote-and-deploy.yml; do
  if grep -Eq 'reconcile-compute-egress|render-compute-egress-allowlist|harden-docker-public-ports' "$REPO_ROOT/.github/workflows/$workflow"; then
    fail "$workflow retains a direct shared-firewall writer"
  fi
done
yq -r '.jobs.promote-k8s.needs[]' "$REPO_ROOT/.github/workflows/promote-and-deploy.yml" \
  | grep -Fxq node-substrate || fail "promotion lost its substrate preflight dependency"
# Explicit infra delivery still runs the renderer and hardener.
grep -Fq 'scripts/ci/deploy-infra.sh' "$REPO_ROOT/.github/workflows/candidate-flight-infra.yml" \
  || fail "candidate infra path lost deploy-infra"
infra_steps="$(yq -r '.jobs.deploy-infra.steps[].run // ""' "$REPO_ROOT/.github/workflows/promote-and-deploy.yml")"
grep -Fq 'scripts/ci/deploy-infra.sh' <<< "$infra_steps" || fail "shared infra path lost deploy-infra"
grep -Fq '"$REPO_ROOT/scripts/ci/render-compute-egress-allowlist.sh" "$DEPLOY_ENVIRONMENT"' "$REPO_ROOT/scripts/ci/deploy-infra.sh" \
  || fail "explicit infra path lost the renderer"
grep -Fq 'STAGED_ALLOWLIST="$REMOTE_COMPUTE_EGRESS_ALLOWLIST" bash "$REMOTE_HARDEN_SCRIPT"' "$REPO_ROOT/scripts/ci/deploy-infra.sh" \
  || fail "explicit infra path lost the shared hardener"
ok "app delivery preserves policy; existing infra path owns writes and workload preflights remain"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# Fake VM toolchain for harden-docker-public-ports.sh
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
FAKEBIN="$TMPROOT/bin"
mkdir -p "$FAKEBIN"
export IPT_STATE="$TMPROOT/iptables.state"
: > "$IPT_STATE"

cat > "$FAKEBIN/iptables" <<'EOF'
#!/usr/bin/env bash
# Stateful fake: one DOCKER-USER rule per line in $IPT_STATE (append order).
set -euo pipefail
case "${1:-}" in
  -L)
    # -L DOCKER-USER [--line-numbers] -n
    if printf '%s\n' "$@" | grep -qx -- '--line-numbers'; then
      echo "Chain DOCKER-USER (1 references)"
      echo "num  target  prot  source"
      nl -ba -w1 -s'    ' "$IPT_STATE"
    fi
    exit 0
    ;;
  -D)
    ln="$3"
    sed -i.bak "${ln}d" "$IPT_STATE"
    exit 0
    ;;
  -A)
    shift 2
    echo "$*" >> "$IPT_STATE"
    exit 0
    ;;
  -S)
    sed 's/^/-A DOCKER-USER /' "$IPT_STATE"
    exit 0
    ;;
esac
exit 0
EOF
chmod +x "$FAKEBIN/iptables"

cat > "$FAKEBIN/ip" <<'EOF'
#!/usr/bin/env bash
echo "8.8.8.8 via 192.0.2.1 dev eth0 src 192.0.2.10 uid 0"
EOF
chmod +x "$FAKEBIN/ip"

printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/flock"
chmod +x "$FAKEBIN/flock"

export PERSISTENCE_STATE="$TMPROOT/persistence.state"
export PERSISTENCE_PLUGIN="$TMPROOT/usr/share/netfilter-persistent/plugins.d/15-ip4tables"
export APT_CALLS="$TMPROOT/apt.calls" PERSISTENCE_CALLS="$TMPROOT/persistence.calls"
mkdir -p "$(dirname "$PERSISTENCE_PLUGIN")"
printf 'installed\n' > "$PERSISTENCE_STATE"
printf '#!/usr/bin/env bash\nexit 0\n' > "$PERSISTENCE_PLUGIN"
chmod +x "$PERSISTENCE_PLUGIN"
export FAKE_APT_MODE=locked
: > "$APT_CALLS"; : > "$PERSISTENCE_CALLS"
cat > "$FAKEBIN/dpkg-query" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  '-W -f=${Status} iptables-persistent')
    case "$(cat "$PERSISTENCE_STATE")" in
      installed) printf 'install ok installed' ;;
      held) printf 'hold ok installed' ;;
      broken) printf 'install reinstreq installed' ;;
      *) exit 1 ;;
    esac ;;
  '-L iptables-persistent') printf '%s\n' "$PERSISTENCE_PLUGIN" ;;
  *) exit 9 ;;
esac
EOF
cat > "$FAKEBIN/apt-get" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$APT_CALLS"
[ "$*" = '-o DPkg::Lock::Timeout=60 install -y iptables-persistent' ] || exit 9
[ "$DEBIAN_FRONTEND" = noninteractive ] || exit 9
case "$FAKE_APT_MODE" in
  locked) echo 'fixture: unattended-upgrades holds frontend lock' >&2; exit 100 ;;
  incomplete) exit 0 ;;
  install)
    printf 'installed\n' > "$PERSISTENCE_STATE"
    printf '#!/usr/bin/env bash\nexit 0\n' > "$PERSISTENCE_PLUGIN"
    chmod +x "$PERSISTENCE_PLUGIN" ;;
  *) exit 9 ;;
esac
EOF
cat > "$FAKEBIN/netfilter-persistent" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
[ "$*" = save ] || exit 9
printf 'save\n' >> "$PERSISTENCE_CALLS"
EOF
chmod +x "$FAKEBIN/dpkg-query" "$FAKEBIN/apt-get" "$FAKEBIN/netfilter-persistent"

export ALLOWLIST_FILE="$TMPROOT/etc/compute-egress-allowlist"
export STAGED_ALLOWLIST="$TMPROOT/staged-allowlist"
export HARDEN_LOCK_FILE="$TMPROOT/harden.lock"
export HARDEN_BOOT_SCRIPT="$TMPROOT/usr/local/sbin/cogni-harden-docker-public-ports.sh"
export HARDEN_BOOT_UNIT="$TMPROOT/etc/systemd/system/cogni-harden-docker-public-ports.service"
export SYSTEMCTL_CALLS="$TMPROOT/systemctl.calls" SYSTEMCTL_ENABLED="$TMPROOT/systemctl.enabled"
: > "$SYSTEMCTL_CALLS"
cat > "$FAKEBIN/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$SYSTEMCTL_CALLS"
case "$*" in
  daemon-reload) ;;
  'reenable --quiet cogni-harden-docker-public-ports.service'|'enable --quiet cogni-harden-docker-public-ports.service')
    : > "$SYSTEMCTL_ENABLED" ;;
  'is-enabled --quiet cogni-harden-docker-public-ports.service')
    [ -f "$SYSTEMCTL_ENABLED" ] ;;
  *) exit 9 ;;
esac
EOF
chmod +x "$FAKEBIN/systemctl"

run_harden() {
  PATH="$FAKEBIN:$PATH" bash "$HARDEN" > "$TMPROOT/harden.log" 2>&1 \
    || { cat "$TMPROOT/harden.log" >&2; fail "harden script exited nonzero"; }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. Harden: staged file → ACCEPTs ahead of the public DROP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# A hand-written file in the hardener's input format (not a catalog render):
# the hardener stays a generic CIDR:ports installer.
FORMAT_LIST="$TMPROOT/format.list"
cat > "$FORMAT_LIST" <<EOF
# hardener file-format fixture
192.0.2.10/32:$PORTS
198.51.100.0/24:$PORTS
EOF
cp "$FORMAT_LIST" "$STAGED_ALLOWLIST"
run_harden

RULES_1="$TMPROOT/rules.1"
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$RULES_1"

for port in 5432 5435 6379 4000 7233; do
  grep -q -- "-s 192.0.2.10/32 -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport $port .*compute-egress-allow.* ACCEPT" "$RULES_1" \
    || { cat "$RULES_1" >&2; fail "staged CIDR did not become a published-port $port ACCEPT"; }
done
grep -q -- "-s 198.51.100.0/24 .*compute-egress-allow" "$RULES_1" || fail "second CIDR missing"
allow_line=$(grep -n 'compute-egress-allow' "$RULES_1" | head -1 | cut -d: -f1)
drop_line=$(grep -n 'drop-public' "$RULES_1" | cut -d: -f1)
[ -n "$drop_line" ] || fail "public DROP rule missing"
[ "$allow_line" -lt "$drop_line" ] || fail "ACCEPT must precede the public DROP"
ok "staged file becomes ACCEPT rules ahead of the public DROP"

[ "$(cat "$ALLOWLIST_FILE")" = "$(cat "$STAGED_ALLOWLIST")" ] \
  || fail "staged file was not installed to ALLOWLIST_FILE"
ok "staged file installed as the persistent allowlist"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. Harden: idempotency + empty-render fail-closed convergence
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/rules.2"
diff -u "$RULES_1" "$TMPROOT/rules.2" || fail "re-run must produce identical rules"
ok "harden re-run is idempotent (byte-identical rules)"

# Reboot persistence (story.5084): the hardener installs a current copy of
# itself plus a docker-bound oneshot unit, enabled but never started inline.
cmp -s "$HARDEN" "$HARDEN_BOOT_SCRIPT" || fail "boot replay script is not the current hardener"
for directive in 'Requires=docker.service' 'After=docker.service network-online.target' \
  'PartOf=docker.service' 'Type=oneshot' 'PrivateTmp=yes' \
  "ExecStart=/bin/bash $HARDEN_BOOT_SCRIPT" 'WantedBy=multi-user.target docker.service'; do
  grep -Fxq -- "$directive" "$HARDEN_BOOT_UNIT" || fail "boot replay unit missing: $directive"
done
[ "$(grep -c '^daemon-reload$' "$SYSTEMCTL_CALLS")" = 1 ] \
  || { cat "$SYSTEMCTL_CALLS" >&2; fail "unit must be written and reloaded exactly once across runs"; }
grep -Fxq 'reenable --quiet cogni-harden-docker-public-ports.service' "$SYSTEMCTL_CALLS" \
  || fail "boot replay unit was not enabled"
if grep -Eq '^(start|restart)( |$)|--now' "$SYSTEMCTL_CALLS"; then
  fail "hardener must never start its own unit (writer-lock re-entry)"
fi
ok "hardener installs and enables its docker-bound boot replay unit idempotently"

# The boot replay runs the installed copy with only the installed allowlist.
PATH="$FAKEBIN:$PATH" STAGED_ALLOWLIST="$TMPROOT/absent-under-private-tmp" \
  bash "$HARDEN_BOOT_SCRIPT" > "$TMPROOT/harden.boot.log" 2>&1 \
  || { cat "$TMPROOT/harden.boot.log" >&2; fail "boot replay exited nonzero"; }
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/rules.boot"
diff -u "$RULES_1" "$TMPROOT/rules.boot" || fail "boot replay must restore the same rules"
[ "$(grep -c '^daemon-reload$' "$SYSTEMCTL_CALLS")" = 1 ] || fail "boot replay rewrote its own unit"
ok "boot replay restores identical rules without rewriting its unit"

# Removal: stage the (empty) production render over the same VM state. This is
# the task.5428 rollout: the old provider rows go away on the next hardener run.
cp "$OUT_PROD" "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/rules.3"
grep -q 'compute-egress-allow' "$TMPROOT/rules.3" \
  && fail "removed CIDRs must be removed from rules on next run"
grep -q 'drop-public' "$TMPROOT/rules.3" \
  || fail "empty allowlist must keep the public DROP (fail-closed, never open)"
ok "empty render converges: no ACCEPTs remain, public DROP stays (fail-closed)"

# No staged file at all (cloud-init boot): last installed state is reused.
rm "$STAGED_ALLOWLIST"
cp "$FORMAT_LIST" "$ALLOWLIST_FILE"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/rules.4"
grep -q 'compute-egress-allow' "$TMPROOT/rules.4" \
  || fail "without a staged file, the installed allowlist must still apply"
ok "no staged file: previously installed allowlist still renders (boot path)"

cp "$OUT_MIGRATION" "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/migration.rules"
grep -q -- '-s 198.51.100.23/32 -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport 5432 .*compute-egress-allow.* ACCEPT' "$TMPROOT/migration.rules" \
  || fail "hardener did not install exact custodian TCP5432 ACCEPT"
if grep '198.51.100.23/32' "$TMPROOT/migration.rules" | grep -qE -- '--ctorigdstport (5435|6379|4000|7233|8080)'; then
  fail "migration custodian gained unrelated substrate ports"
fi
ok "existing hardener installs custodian /32 for TCP5432 only"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/migration.rules.second"
diff -u "$TMPROOT/migration.rules" "$TMPROOT/migration.rules.second" || fail "custodian rule is not idempotent"
cp "$OUT_PROD" "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/migration.removed"
grep -q '198.51.100.23/32' "$TMPROOT/migration.removed" && fail "custodian rule did not converge away"
grep -q 'drop-public' "$TMPROOT/migration.removed" || fail "custodian removal lost public DROP"
ok "custodian admission is idempotent and removed with placement/control convergence"

# The hardener must install only the declared port for a port-scoped line.
printf '%s\n' '65.108.194.156/32:7233' > "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/scoped-installed.rules"
grep -q -- '-s 65.108.194.156/32 -p tcp -m conntrack --ctdir ORIGINAL --ctorigdstport 7233 .*compute-egress-allow.* ACCEPT' "$TMPROOT/scoped-installed.rules" || fail "Temporal-only rule missing"
if grep '65.108.194.156/32' "$TMPROOT/scoped-installed.rules" | grep -qE -- '--ctorigdstport (5432|5435)'; then fail "Temporal NAT gained database access"; fi
ok "hardener installs a port-scoped line for that port only"

# Both services DNAT to container TCP5432. Each grant must retain its distinct
# original published port, including the Dolt-only grant required after PG isolation.
for published_port in 5432 5435; do
  printf '%s\n' "198.51.100.42/32:$published_port" > "$STAGED_ALLOWLIST"
  run_harden
  PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/dnat-$published_port.rules"
  grants=$(grep 'compute-egress-allow' "$TMPROOT/dnat-$published_port.rules")
  [ "$(printf '%s\n' "$grants" | wc -l | tr -d ' ')" = 1 ] || fail "published-port grant widened"
  printf '%s\n' "$grants" | grep -q -- "--ctdir ORIGINAL --ctorigdstport $published_port " \
    || fail "grant lost original destination port $published_port"
  if printf '%s\n' "$grants" | grep -q -- '--dport'; then fail "grant matches translated container ports"; fi
done
ok "Postgres-only and Doltgres-only grants distinguish their original published ports"

incident_rule='-s 157.180.108.139/32 -p tcp --dport 5432 -m conntrack --ctorigdstport 5432 -m comment --comment incident-bug.5442-poly-prod-shed -j REJECT --reject-with tcp-reset'
printf '%s\n' "$incident_rule" >> "$IPT_STATE"
run_harden
grep -Fxq -- "$incident_rule" "$IPT_STATE" || fail "hardener changed the scoped incident fence"
ok "routine hardening preserves the corrected Postgres incident fence"

# A long live chain exceeds the pipe buffer. Finding the first managed rule must
# still drain iptables' output, or pipefail turns SIGPIPE into exit 141.
printf '%s\n' '-m comment --comment cogni-harden-internal-ports:old -j ACCEPT' > "$IPT_STATE"
awk 'BEGIN { for (i=1; i<=2000; i++) print "-s 192.0.2.1/32 -p tcp --dport 5432 -m comment --comment unmanaged-fixture-" i " -j REJECT" }' >> "$IPT_STATE"
run_harden
[ "$(grep -c unmanaged-fixture "$IPT_STATE")" = 2000 ] || fail "large-chain reconciliation changed unmanaged fences"
grep -q 'cogni-harden-internal-ports:old' "$IPT_STATE" && fail "large-chain reconciliation retained stale managed rules"
grep -q 'cogni-harden-internal-ports:drop-public' "$IPT_STATE" || fail "large-chain reconciliation lost public DROP"
ok "large-chain reconciliation drains iptables output and preserves unmanaged fences"

# The healthy dependency must never touch apt, even while its frontend is locked.
[ ! -s "$APT_CALLS" ] || fail "healthy installed persistence invoked apt"
[ -s "$PERSISTENCE_CALLS" ] || fail "healthy path skipped persistence save"
grep -q 'persistence_dependency=healthy apt=skipped' "$TMPROOT/harden.log" || fail "healthy skip branch not observable"
ok "healthy package, persistence command and executable package-owned plugin skip apt entirely"

printf 'held\n' > "$PERSISTENCE_STATE"
run_harden
[ ! -s "$APT_CALLS" ] || fail "healthy held package invoked apt"
grep -q 'persistence_dependency=healthy apt=skipped' "$TMPROOT/harden.log" || fail "held healthy path not observed"
ok "healthy held persistence stays on its installed version without any apt operation"

printf 'broken\n' > "$PERSISTENCE_STATE"
FAKE_APT_MODE=incomplete; export FAKE_APT_MODE
: > "$PERSISTENCE_CALLS"
if PATH="$FAKEBIN:$PATH" bash "$HARDEN" > "$TMPROOT/broken-package.log" 2>&1; then
  fail "reinstreq package was treated as healthy"
fi
[ ! -s "$PERSISTENCE_CALLS" ] || fail "broken package claimed persistence save"
grep -q 'reason=install_postcheck_failed' "$TMPROOT/broken-package.log" || fail "broken package failed for wrong reason"
ok "an installed package requiring reinstallation cannot pass the healthy predicate"

printf 'missing\n' > "$PERSISTENCE_STATE"
rm "$PERSISTENCE_PLUGIN"
FAKE_APT_MODE=install; export FAKE_APT_MODE
: > "$APT_CALLS"; : > "$PERSISTENCE_CALLS"
run_harden
[ "$(wc -l < "$APT_CALLS" | tr -d ' ')" = 1 ] || fail "missing persistence must install once"
[ "$(cat "$PERSISTENCE_CALLS")" = save ] || fail "installed persistence not saved"
grep -q 'persistence_dependency=healthy apt=installed' "$TMPROOT/harden.log" || fail "verified install branch not observable"
ok "missing dependency installs with a finite native lock wait, verifies and saves"

# A nominally installed package with a non-executable/missing plugin is unhealthy.
# A successful apt no-op does not prove that a broken installation was repaired.
chmod -x "$PERSISTENCE_PLUGIN"
FAKE_APT_MODE=incomplete; export FAKE_APT_MODE
: > "$APT_CALLS"; : > "$PERSISTENCE_CALLS"
if PATH="$FAKEBIN:$PATH" bash "$HARDEN" > "$TMPROOT/broken-persistence.log" 2>&1; then
  fail "broken persistence accepted a successful apt no-op"
fi
[ "$(wc -l < "$APT_CALLS" | tr -d ' ')" = 1 ] || fail "broken plugin bypassed dependency install"
[ ! -s "$PERSISTENCE_CALLS" ] || fail "broken persistence claimed save"
grep -q 'reason=install_postcheck_failed' "$TMPROOT/broken-persistence.log" || fail "postcheck failure not observable"
grep -q 'cogni-harden-internal-ports:drop-public' "$IPT_STATE" || fail "postcheck failure lost public DROP"
ok "broken installed persistence fails closed after install/postcheck"

rm "$PERSISTENCE_PLUGIN"
mkdir "$PERSISTENCE_PLUGIN"
: > "$PERSISTENCE_CALLS"
if PATH="$FAKEBIN:$PATH" bash "$HARDEN" > "$TMPROOT/directory-plugin.log" 2>&1; then
  fail "an executable directory was accepted as the persistence plugin"
fi
[ ! -s "$PERSISTENCE_CALLS" ] || fail "directory plugin claimed save"
grep -q 'reason=install_postcheck_failed' "$TMPROOT/directory-plugin.log" || fail "directory plugin failed for wrong reason"
rmdir "$PERSISTENCE_PLUGIN"
ok "an executable directory cannot masquerade as the IPv4 persistence plugin"

printf 'missing\n' > "$PERSISTENCE_STATE"
FAKE_APT_MODE=locked; export FAKE_APT_MODE
: > "$APT_CALLS"; : > "$PERSISTENCE_CALLS"
status=0
PATH="$FAKEBIN:$PATH" bash "$HARDEN" > "$TMPROOT/locked-persistence.log" 2>&1 || status=$?
[ "$status" = 100 ] || fail "native apt lock failure not propagated"
[ "$(wc -l < "$APT_CALLS" | tr -d ' ')" = 1 ] || fail "apt lock failure retried"
grep -Fxq -- '-o DPkg::Lock::Timeout=60 install -y iptables-persistent' "$APT_CALLS" || fail "apt lock wait not bounded"
[ ! -s "$PERSISTENCE_CALLS" ] || fail "lock failure claimed persistence save"
grep -q 'reason=install_failed native_rc=100' "$TMPROOT/locked-persistence.log" || fail "native failure not observable"
if grep -q '\[harden\] done' "$TMPROOT/locked-persistence.log"; then fail "lock failure claimed hardener completion"; fi
grep -q 'cogni-harden-internal-ports:drop-public' "$IPT_STATE" || fail "lock failure lost public DROP"
ok "missing dependency propagates apt lock failure without retry or false completion"

echo "PASS: all $PASS assertions"
