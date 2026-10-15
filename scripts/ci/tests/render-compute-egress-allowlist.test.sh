#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Module: scripts/ci/tests/render-compute-egress-allowlist.test.sh
# Purpose: Prove the catalog→VM compute-egress allowlist path (task.5052):
#   1. render-compute-egress-allowlist.sh renders per-env allow lines from a
#      catalog fixture (env scoping, PLACEMENT scoping, dedupe, determinism,
#      fail-loud validation). bug.5191: `envs:` membership alone must NOT open a
#      row's provider NAT — only `deployment_provider.<env>: akash` may;
#   2. harden-docker-public-ports.sh (faked iptables) installs the staged render
#      and places ACCEPTs ahead of the public DROP;
#   3. idempotency — re-running produces byte-identical rules;
#   4. fail-closed — an empty render yields NO compute ACCEPTs while the public
#      DROP remains, and catalog removal converges on the next run.
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
compute_egress_cidrs:
  - cidr: 80.200.246.35/32
    comment: shared zencloud+digitalfrontier Akash egress NAT (story.5016)
  - cidr: 198.51.100.0/24
    comment: second provider block (fixture)
EOF

cat > "$CATALOG/toksb.yaml" <<'EOF'
name: toksb
type: node
envs: [preview]
deployment_provider:
  preview: akash
compute_egress_cidrs:
  - cidr: 203.0.113.7/32
    comment: preview-only provider (fixture)
EOF

# Duplicate CIDR from a second candidate-a row — must render exactly once.
cat > "$CATALOG/toksdup.yaml" <<'EOF'
name: toksdup
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: akash
compute_egress_cidrs:
  - cidr: 80.200.246.35/32
    comment: same NAT reused by another node (fixture)
EOF

# bug.5191 — PLACEMENT, not membership. Explicit k3s in the only env it deploys
# to: this row's CIDR must never appear in any render.
cat > "$CATALOG/toksk3s.yaml" <<'EOF'
name: toksk3s
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: k3s
compute_egress_cidrs:
  - cidr: 192.0.2.77/32
    comment: k3s-placed row must open no provider hole (fixture)
EOF

# bug.5191 — the same row in TWO envs with different placement. K3S_IS_DEFAULT:
# candidate-a has no override, so it is k3s and contributes nothing there; preview
# is akash and contributes. One row, one CIDR, opposite outcomes per env.
cat > "$CATALOG/tokssplit.yaml" <<'EOF'
name: tokssplit
type: node
envs: [candidate-a, preview]
deployment_provider:
  preview: akash
compute_egress_cidrs:
  - cidr: 192.0.2.99/32
    comment: provider NAT for the preview placement only (fixture)
EOF

# Rows without the field / without envs must contribute nothing.
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
# Existing provider-only cases represent an isolated fleet, with no production
# custodian and no implicit DNS/domain authority.
export FLEET_CONTROL_ENV=candidate-a
unset FORK_DOMAIN_ROOT COGNI_DOMAIN_ROOT COGNI_DEPLOYMENT_SLUG
PORTS="5432,5435,6379,4000,7233"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 1. Renderer: env scoping + dedupe + exact allow lines
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUT_A="$TMPROOT/candidate-a.list"
bash "$RENDERER" candidate-a > "$OUT_A"

EXPECTED_A="$TMPROOT/candidate-a.expected"
grep -v '^#' "$OUT_A" > "$TMPROOT/candidate-a.rules" || true
cat > "$EXPECTED_A" <<EOF
80.200.246.35/32:$PORTS
198.51.100.0/24:$PORTS
EOF
diff -u "$EXPECTED_A" "$TMPROOT/candidate-a.rules" \
  || fail "candidate-a rules differ from expected (env union + first-wins dedupe)"
ok "candidate-a renders exactly its env's CIDRs, port-scoped, deduped"

grep -q '203.0.113.7' "$OUT_A" && fail "preview-only CIDR leaked into candidate-a"
ok "preview-only CIDR excluded from candidate-a"

grep -q '^# toksa: shared zencloud+digitalfrontier' "$OUT_A" \
  || fail "provenance comment missing from render"
ok "catalog comments carried into rendered file"

# bug.5191 — membership in envs[] is NOT authority to open a provider hole.
grep -q '192.0.2.77' "$OUT_A" \
  && fail "explicitly k3s-placed row (toksk3s) leaked its CIDR into candidate-a"
ok "explicitly k3s-placed row contributes no CIDR to the env it deploys to"

grep -q '192.0.2.99' "$OUT_A" \
  && fail "placement-defaulted (k3s) row (tokssplit) leaked its CIDR into candidate-a"
ok "K3S_IS_DEFAULT: row with no override for the env contributes no CIDR there"

OUT_P="$TMPROOT/preview.list"
bash "$RENDERER" preview > "$OUT_P"
EXPECTED_P="$TMPROOT/preview.expected"
grep -v '^#' "$OUT_P" > "$TMPROOT/preview.rules" || true
cat > "$EXPECTED_P" <<EOF
203.0.113.7/32:$PORTS
192.0.2.99/32:$PORTS
EOF
diff -u "$EXPECTED_P" "$TMPROOT/preview.rules" \
  || fail "preview rules differ from expected (akash-placed rows only)"
ok "preview renders exactly its akash-placed rows' CIDRs"

# The SAME tokssplit row that was excluded from candidate-a IS included here —
# proof the filter is placement, not a blanket suppression of the row.
grep -q "^192.0.2.99/32:$PORTS$" "$OUT_P" \
  || fail "akash-placed env of a split-placement row must still contribute"
ok "split-placement row contributes in its akash env and only there"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 2. Renderer: empty env + idempotency + fail-loud validation
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
OUT_PROD="$TMPROOT/production.list"
bash "$RENDERER" production > "$OUT_PROD"
if grep -qv '^#' "$OUT_PROD"; then
  fail "production (no declaring rows) must render zero allow lines"
fi
ok "env with no external compute renders an allow-free (fail-closed) file"

bash "$RENDERER" candidate-a > "$TMPROOT/candidate-a.second"
diff -u "$OUT_A" "$TMPROOT/candidate-a.second" || fail "renderer is not deterministic"
ok "renderer is deterministic/idempotent"

cat > "$CATALOG/broken.yaml" <<'EOF'
name: broken
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: akash
compute_egress_cidrs:
  - cidr: not-a-cidr
    comment: bad
EOF
if bash "$RENDERER" candidate-a > /dev/null 2>&1; then
  fail "renderer must fail LOUD on an invalid CIDR"
fi
rm "$CATALOG/broken.yaml"
ok "invalid CIDR aborts the render (never warn-skipped on the VM)"

# An unresolvable placement must abort, never silently fall through to "not akash"
# (that would turn a catalog typo into a quiet, unnoticed firewall change).
cat > "$CATALOG/badplacement.yaml" <<'EOF'
name: badplacement
type: node
envs: [candidate-a]
deployment_provider:
  candidate-a: fly
compute_egress_cidrs:
  - cidr: 198.18.0.1/32
    comment: unsupported provider (fixture)
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
grep -v '^#' "$OUT_MIGRATION" | grep -v '^198.51.100.23/32:5432$' > "$TMPROOT/provider-preserved"
diff -u "$EXPECTED_A" "$TMPROOT/provider-preserved" || fail "provider rules changed"
ok "foreign nonproduction lanes add exactly one custodian /32:5432; provider rules unchanged"

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
diff -u "$OUT_A" "$TMPROOT/control-twin.list" || fail "control-host twin provider rows changed or gained a migration rule"
[ ! -s "$DNS_QUERY_LOG" ] || fail "control-host twin resolved foreign migration trust"
ok "actual production control-host twin preserves provider rules with NO custodian/self admission"

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

env "${MIGRATION_ENV[@]}" FAKE_MIGRATION_IPS='80.200.246.35' \
  bash "$RENDERER" candidate-a > "$TMPROOT/shared-source.list"
grep -Fxq "80.200.246.35/32:$PORTS" "$TMPROOT/shared-source.list" || fail "provider port declaration changed"
grep -Fxq '80.200.246.35/32:5432' "$TMPROOT/shared-source.list" || fail "provider CIDR dedupe suppressed migration rule"
ok "custodian rule dedupe is independent of a matching provider CIDR"

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
  || fail "native migration admission wrongly depends on provider CIDRs"
ok "an actual foreign Akash lane needs migration admission even without provider CIDRs"
yq -i '.deployment_provider."candidate-a" = "k3s"' "$MIGRATION_ONLY_CATALOG/only.yaml"
: > "$DNS_QUERY_LOG"
env "${MIGRATION_ENV[@]}" COGNI_CATALOG_ROOT="$MIGRATION_ONLY_CATALOG" \
  bash "$RENDERER" candidate-a > "$TMPROOT/k3s-only.list"
grep -qv '^#' "$TMPROOT/k3s-only.list" && fail "k3s-only lane gained migration admission"
[ ! -s "$DNS_QUERY_LOG" ] || fail "k3s-only lane performed foreign DNS"
ok "a k3s-only lane resolves and admits no foreign migration control"

ACTION="$REPO_ROOT/.github/actions/reconcile-compute-egress/action.yml"
[ "$(yq -r '.runs.steps[0].env.FORK_DOMAIN_ROOT' "$ACTION")" = '${{ vars.FORK_DOMAIN_ROOT }}' ] \
  || fail "composite must source explicit repo-owned root, not inherit DAO fallback"
[ "$(yq -r '.runs.steps[0].env.DESTINATION_ENVIRONMENT' "$ACTION")" = '${{ inputs.destination_environment || inputs.environment }}' ] \
  || fail "composite destination must default to lane"
for workflow in candidate-flight.yml promote-and-deploy.yml; do
  actual_destination="$(yq -r '.jobs.reconcile-compute-egress-control.steps[] | select(.uses == "./app-src/.github/actions/reconcile-compute-egress") | .with.destination_environment' "$REPO_ROOT/.github/workflows/$workflow")"
  [ "$actual_destination" = '${{ vars.FLEET_CONTROL_ENV || '\''production'\'' }}' ] \
    || fail "$workflow control twin did not declare its actual destination"
done
yq -r '.jobs.reconcile-compute-egress.if' "$REPO_ROOT/.github/workflows/promote-and-deploy.yml" \
  | grep -Fq "needs.decide.outputs.has_external_compute_node_targets == 'true'" \
  || fail "foreign Akash-only promote must reconcile its lane-owned Postgres firewall"
ok "canonical composite/control twins preserve explicit trust provenance and actual destination; Akash owner job runs"

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

for tool in apt-get netfilter-persistent flock; do
  printf '#!/usr/bin/env bash\nexit 0\n' > "$FAKEBIN/$tool"
  chmod +x "$FAKEBIN/$tool"
done

export ALLOWLIST_FILE="$TMPROOT/etc/compute-egress-allowlist"
export STAGED_ALLOWLIST="$TMPROOT/staged-allowlist"
export HARDEN_LOCK_FILE="$TMPROOT/harden.lock"

run_harden() {
  PATH="$FAKEBIN:$PATH" bash "$HARDEN" > "$TMPROOT/harden.log" 2>&1 \
    || { cat "$TMPROOT/harden.log" >&2; fail "harden script exited nonzero"; }
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 3. Harden: staged render → ACCEPTs ahead of the public DROP
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
cp "$OUT_A" "$STAGED_ALLOWLIST"
run_harden

RULES_1="$TMPROOT/rules.1"
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$RULES_1"

grep -q -- "-s 80.200.246.35/32 -p tcp -m multiport --dports $PORTS .*compute-egress-allow.* ACCEPT" "$RULES_1" \
  || { cat "$RULES_1" >&2; fail "catalog CIDR did not become a port-scoped ACCEPT"; }
grep -q -- "-s 198.51.100.0/24 .*compute-egress-allow" "$RULES_1" || fail "second CIDR missing"
allow_line=$(grep -n 'compute-egress-allow' "$RULES_1" | head -1 | cut -d: -f1)
drop_line=$(grep -n 'drop-public' "$RULES_1" | cut -d: -f1)
[ -n "$drop_line" ] || fail "public DROP rule missing"
[ "$allow_line" -lt "$drop_line" ] || fail "ACCEPT must precede the public DROP"
ok "staged render becomes ACCEPT rules ahead of the public DROP"

[ "$(cat "$ALLOWLIST_FILE")" = "$(cat "$STAGED_ALLOWLIST")" ] \
  || fail "staged file was not installed to ALLOWLIST_FILE"
ok "staged catalog render installed as the persistent allowlist"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 4. Harden: idempotency + empty-render fail-closed convergence
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/rules.2"
diff -u "$RULES_1" "$TMPROOT/rules.2" || fail "re-run must produce identical rules"
ok "harden re-run is idempotent (byte-identical rules)"

# Catalog removal: stage the (empty) production render over the same VM state.
cp "$OUT_PROD" "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/rules.3"
grep -q 'compute-egress-allow' "$TMPROOT/rules.3" \
  && fail "removed catalog CIDRs must be removed from rules on next run"
grep -q 'drop-public' "$TMPROOT/rules.3" \
  || fail "empty allowlist must keep the public DROP (fail-closed, never open)"
ok "empty render converges: no ACCEPTs remain, public DROP stays (fail-closed)"

# No staged file at all (cloud-init boot): last installed state is reused.
rm "$STAGED_ALLOWLIST"
cp "$OUT_A" "$ALLOWLIST_FILE"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/rules.4"
grep -q 'compute-egress-allow' "$TMPROOT/rules.4" \
  || fail "without a staged file, the installed allowlist must still apply"
ok "no staged file: previously installed allowlist still renders (boot path)"

cp "$OUT_MIGRATION" "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/migration.rules"
grep -q -- '-s 198.51.100.23/32 -p tcp -m multiport --dports 5432 .*compute-egress-allow.* ACCEPT' "$TMPROOT/migration.rules" \
  || fail "hardener did not install exact custodian TCP5432 ACCEPT"
if grep '198.51.100.23/32' "$TMPROOT/migration.rules" | grep -qE -- '--dports (5432,|5435|6379|4000|7233|8080)'; then
  fail "migration custodian gained unrelated substrate ports"
fi
ok "existing hardener installs custodian /32 for TCP5432 only"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/migration.rules.second"
diff -u "$TMPROOT/migration.rules" "$TMPROOT/migration.rules.second" || fail "custodian rule is not idempotent"
cp "$OUT_A" "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/migration.removed"
grep -q '198.51.100.23/32' "$TMPROOT/migration.removed" && fail "custodian rule did not converge away"
grep -q 'drop-public' "$TMPROOT/migration.removed" || fail "custodian removal lost public DROP"
ok "custodian admission is idempotent and removed with catalog/control convergence"

# Entry-level scope preserves defaults while admitting a production Temporal NAT
# without granting database access or leaking into another environment.
SCOPED_CATALOG="$TMPROOT/scoped-catalog"
mkdir -p "$SCOPED_CATALOG"
cat > "$SCOPED_CATALOG/scopea.yaml" <<'EOF'
name: scopea
type: node
envs: [candidate-a, production]
deployment_provider: {candidate-a: akash, production: akash}
compute_egress_cidrs:
  - {cidr: 65.108.194.156/32, ports: [7233], envs: [production], comment: production Temporal only}
  - {cidr: 65.108.194.156/32, ports: [5432], envs: [candidate-a], comment: distinct candidate database scope}
  - {cidr: 198.51.100.30/32, ports: [7233, 5432], envs: [production], comment: normalized pair}
  - {cidr: 198.51.100.30/32, ports: [5432, 7233], envs: [production], comment: equivalent reordered pair}
EOF
COGNI_CATALOG_ROOT="$SCOPED_CATALOG" bash "$RENDERER" production > "$TMPROOT/scoped-production.list"
grep -v '^#' "$TMPROOT/scoped-production.list" > "$TMPROOT/scoped-production.rules"
printf '%s\n' '65.108.194.156/32:7233' '198.51.100.30/32:5432,7233' > "$TMPROOT/scoped-production.expected"
diff -u "$TMPROOT/scoped-production.expected" "$TMPROOT/scoped-production.rules" || fail "production scoped rules differ"
COGNI_CATALOG_ROOT="$SCOPED_CATALOG" bash "$RENDERER" candidate-a > "$TMPROOT/scoped-candidate.list"
grep -v '^#' "$TMPROOT/scoped-candidate.list" > "$TMPROOT/scoped-candidate.rules"
printf '%s\n' '65.108.194.156/32:5432' > "$TMPROOT/scoped-candidate.expected"
diff -u "$TMPROOT/scoped-candidate.expected" "$TMPROOT/scoped-candidate.rules" || fail "entry environment scope leaked"
ok "entry scopes preserve distinct same-CIDR ports and normalize equivalent sets"

# The unchanged hardener must install only the declared Temporal port for Poly.
cp "$TMPROOT/scoped-production.list" "$STAGED_ALLOWLIST"
run_harden
PATH="$FAKEBIN:$PATH" iptables -S DOCKER-USER > "$TMPROOT/scoped-installed.rules"
grep -q -- '-s 65.108.194.156/32 -p tcp -m multiport --dports 7233 .*compute-egress-allow.* ACCEPT' "$TMPROOT/scoped-installed.rules" || fail "Temporal-only rule missing"
if grep '65.108.194.156/32' "$TMPROOT/scoped-installed.rules" | grep -q -- '--dports 5432'; then fail "Temporal NAT gained database access"; fi
ok "hardener installs new production NAT for Temporal only"

cp "$SCOPED_CATALOG/scopea.yaml" "$TMPROOT/scope-valid.yaml"
for mutation in '.compute_egress_cidrs[0].ports = []' '.compute_egress_cidrs[0].ports = [8080]' '.compute_egress_cidrs[0].ports = ["7233"]' '.compute_egress_cidrs[0].envs = []' '.compute_egress_cidrs[0].envs = ["preview"]'; do
  yq "$mutation" "$TMPROOT/scope-valid.yaml" > "$SCOPED_CATALOG/scopea.yaml"
  if COGNI_CATALOG_ROOT="$SCOPED_CATALOG" bash "$RENDERER" production > /dev/null 2>&1; then fail "invalid entry scope accepted: $mutation"; fi
done
ok "renderer rejects empty, unsupported and out-of-row entry scopes"

echo "PASS: all $PASS assertions"
