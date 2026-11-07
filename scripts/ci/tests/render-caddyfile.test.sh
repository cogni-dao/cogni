#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Unit tests for catalog-driven edge routing (task.5078):
#   1. The committed Caddyfile.tmpl is in sync with the catalog (drift gate —
#      this is what makes "add a node = 1 catalog PR" enforceable).
#   2. Every type:node gets an edge block (the regression the hand-maintained
#      roster shipped: a catalog node with no edge route). The generic
#      NODE_TARGETS loop covers every node, so no single node is special-cased.
#   3. catalog node_port == per-env overlay Service nodePort (the one coupling
#      this design introduces; assert it can't drift into split-brain).
#   4. Caddy runtime + access logs go to stdout for Alloy Docker collection.
#   5. The edge-saturation metric set survives Alloy's strict allowlist.
#   6. The derived node DB inventory includes every catalog node.
#   7. Infra reconcile cannot inline/overlap production backups, and Postgres
#      crash attribution remains observable.
#   8. task.5428 mesh VM sites: one relay site + one publish path per tailnet of
#      the VM (both candidate-a tailnets), DNS-only ACME, a both-present check,
#      edge-only NodePorts dropped after DOCKER-USER, no deploy-infra change.
#
# Run: bash scripts/ci/tests/render-caddyfile.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
cd "$REPO_ROOT"

# shellcheck source=scripts/ci/lib/image-tags.sh
source "$REPO_ROOT/scripts/ci/lib/image-tags.sh"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "  ok — $*"; }

echo "[1/7] Caddyfile.tmpl ↔ catalog drift gate"
bash scripts/ci/render-caddyfile.sh --check >/dev/null \
  || fail "render-caddyfile.sh --check: committed Caddyfile.tmpl is stale (run: pnpm gen:caddyfile)"
pass "committed Caddyfile.tmpl matches the catalog"

echo "[2/7] every type:node has an edge block (catalog-driven, no node special-cased)"
RENDERED="$(bash scripts/ci/render-caddyfile.sh)"
local_certs_count="$(grep -c '^  local_certs$' <<<"$RENDERED")"
[ "$local_certs_count" = "1" ] \
  || fail "expected one global local_certs directive for the Cloudflare origin, found $local_certs_count"
pass "Cloudflare origin uses local certificates (no proxied public-ACME dependency)"
for node in "${NODE_TARGETS[@]}"; do
  slug="$(printf '%s' "$node" | tr '[:lower:]-' '[:upper:]_')"
  if is_primary_host "$node"; then
    # Primary serves the bare ${DOMAIN}; its upstream stays the docker-DNS dev
    # default (app:3000) and is overridden to the NodePort at deploy time.
    grep -q '{$DOMAIN} {' <<<"$RENDERED" || fail "primary node '$node' missing bare-domain block"
    pass "$node → bare-domain primary block"
  else
    grep -q "{\$${slug}_DOMAIN" <<<"$RENDERED" || fail "node '$node' has no {\$${slug}_DOMAIN} site block"
    grep -q "host.docker.internal:$(node_port_for_target "$node")" <<<"$RENDERED" \
      || fail "node '$node' upstream missing baked node_port $(node_port_for_target "$node")"
    pass "$node → edge block + upstream :$(node_port_for_target "$node")"
  fi
done

echo "[materialized] runtime Caddyfile contains current values, not env placeholders"
DOMAIN_UNDER_TEST="test.cognidao.org"
MATERIALIZED="$(bash scripts/ci/render-caddyfile.sh --domain "$DOMAIN_UNDER_TEST")"
if grep -Fq '{$' <<<"$MATERIALIZED"; then
  fail "materialized Caddyfile still depends on the running container's stale env"
fi
for node in "${NODE_TARGETS[@]}"; do
  grep -Fq "$(host_for_node "$node" "$DOMAIN_UNDER_TEST") {" <<<"$MATERIALIZED" \
    || fail "materialized Caddyfile missing current host for '$node'"
  grep -Fq "reverse_proxy host.docker.internal:$(node_port_for_target "$node")" <<<"$MATERIALIZED" \
    || fail "materialized Caddyfile missing current upstream for '$node'"
done
pass "all catalog routes are materialized for $DOMAIN_UNDER_TEST"

echo "[materialized] base domain validation is label-aware"
for valid_domain in localhost a.b foo-bar.example.com; do
  bash scripts/ci/render-caddyfile.sh --domain "$valid_domain" >/dev/null \
    || fail "valid base domain was rejected: $valid_domain"
done
for invalid_domain in foo.-bar.com foo-.bar.com -foo.example.com foo.example.com- foo..example.com; do
  if bash scripts/ci/render-caddyfile.sh --domain "$invalid_domain" >/dev/null 2>&1; then
    fail "invalid base domain was accepted: $invalid_domain"
  fi
done
pass "localhost remains supported; labels with boundary hyphens are rejected"

echo "[3/7] catalog node_port == overlay Service nodePort (no split-brain)"
for node in "${NODE_TARGETS[@]}"; do
  cat_port="$(node_port_for_target "$node")"
  for env in candidate-a candidate-b preview production; do
    f="infra/k8s/overlays/$env/$node/kustomization.yaml"
    [ -f "$f" ] || { echo "  skip — $env/$node (no overlay)"; continue; }
    # nodePort lives in a JSON6902 patch: `path: /spec/ports/0/nodePort` / `value: NNNNN`
    ov_port="$(grep -A1 'nodePort' "$f" | grep -oE 'value: *[0-9]+' | grep -oE '[0-9]+' | head -1)"
    [ -n "$ov_port" ] || fail "$f: could not read Service nodePort"
    [ "$ov_port" = "$cat_port" ] \
      || fail "$node: catalog node_port=$cat_port != $env overlay nodePort=$ov_port (CATALOG_IS_SSOT — make them match)"
    pass "$node/$env nodePort=$ov_port matches catalog"
  done
done

echo "[4/7] Caddy logs are collectible from container stdout"
stdout_loggers="$(grep -c 'output stdout' <<<"$RENDERED")"
expected_loggers="$(( ${#NODE_TARGETS[@]} + 1 ))"
[ "$stdout_loggers" = "$expected_loggers" ] \
  || fail "expected $expected_loggers stdout loggers (global + one/site), found $stdout_loggers"
if grep -q 'output file /data/logs/caddy' <<<"$RENDERED"; then
  fail "Caddy writes logs to its private /data volume; Alloy cannot collect them"
fi
pass "global + per-site JSON logs emit to stdout"

echo "[5/7] Alloy keeps edge saturation counters"
ALLOY_CONFIG="infra/compose/runtime/configs/alloy-config.metrics.alloy"
for metric in \
  node_nf_conntrack_entries \
  node_nf_conntrack_entries_limit \
  node_netstat_TcpExt_ListenDrops \
  node_netstat_TcpExt_ListenOverflows \
  node_netstat_TcpExt_SyncookiesFailed \
  node_netstat_TcpExt_TCPAbortOnMemory; do
  grep -q "$metric" "$ALLOY_CONFIG" || fail "$ALLOY_CONFIG drops required edge metric $metric"
done
pass "conntrack, listen-overflow, SYN-cookie, and abort-on-memory counters are allowlisted"

echo "[6/7] catalog node DB inventory includes every type:node"
dbs="$(node_database_csv)"
for node in "${NODE_TARGETS[@]}"; do
  expected_db="$(node_database_for_target "$node")"
  case ",$dbs," in
    *",$expected_db,"*) pass "$node -> $expected_db" ;;
    *) fail "derived DB inventory '$dbs' missing $expected_db for node '$node'" ;;
  esac
done

echo "[7/7] production reconcile contains backup load and retries the OpenBao login seam"
DEPLOY_INFRA="scripts/ci/deploy-infra.sh"
RUNTIME_COMPOSE="infra/compose/runtime/docker-compose.yml"
grep -Fq 'if [[ "$DEPLOY_ENVIRONMENT" == candidate-* ]]; then' "$DEPLOY_INFRA" \
  || fail "full backup validation is not candidate-gated"
grep -Fq 'systemctl start cogni-db-backup.service' "$DEPLOY_INFRA" \
  || fail "candidate validation bypasses the singleton systemd service"
grep -Fq 'OnUnitInactiveSec=${BACKUP_INTERVAL_SECONDS}s' "$DEPLOY_INFRA" \
  || fail "backup cadence is not completion-relative"
! grep -Fq 'OnBootSec=' "$DEPLOY_INFRA" \
  || fail "boot-relative timer can launch a full dump during ordinary reconcile"
! grep -Fq '$RUNTIME_COMPOSE --profile backup stop db-backup' "$DEPLOY_INFRA" \
  || fail "reconcile still kills an in-progress backup"
grep -Fq 'mem_limit: 512m' "$RUNTIME_COMPOSE" \
  || fail "backup client has no memory ceiling"
grep -Fq 'oom_score_adj: 500' "$RUNTIME_COMPOSE" \
  || fail "backup client is not preferred over serving state under memory pressure"
grep -Fq 'loki.source.journal "kernel"' "$ALLOY_CONFIG" \
  || fail "kernel OOM/SIGKILL evidence is not shipped to Loki"
grep -Eq 'regex[[:space:]]*= .*postgres.*temporal-postgres' "$ALLOY_CONFIG" \
  || fail "PostgreSQL stderr is not shipped to Loki"
grep -Fq 'server_transient) max_attempts=3' "$DEPLOY_INFRA" \
  || fail "OpenBao writer login has no bounded transient retry"
grep -Fq '[[ $rc -eq 124 ]]' "$DEPLOY_INFRA" \
  || fail "OpenBao writer login does not classify a silent GNU timeout as transient"
grep -Fq 'permission_denied_recheck) max_attempts=2' "$DEPLOY_INFRA" \
  || fail "OpenBao writer login does not recheck a 403 with one fresh JWT"
grep -Fq 'OpenBao writer login failed permanently' "$DEPLOY_INFRA" \
  || fail "unknown OpenBao login failures do not fail closed"
grep -Fq 'classify_kubectl_resource_lookup_failure' "$DEPLOY_INFRA" \
  || fail "OpenBao writer SA lookup does not distinguish timeout from absence"
grep -Fq 'OpenBao writer SA lookup remained unavailable after 3 attempts' "$DEPLOY_INFRA" \
  || fail "OpenBao writer SA lookup has no bounded transient retry"
grep -Fq 'refusing to claim the SA is absent' "$DEPLOY_INFRA" \
  || fail "unknown OpenBao writer SA lookup failures invent absence"
pass "backup execution is candidate-gated + serialized; OpenBao login and SA lookup retries are bounded and fail-closed"

echo "[8/8] mesh edge sites: relay + publish per VM tailnet, coordinator per sequencer tailnet, DNS-only ACME, hardened (task.5428 P2)"
# shellcheck source=scripts/ci/lib/mesh-plane.sh
source "$REPO_ROOT/scripts/ci/lib/mesh-plane.sh"
# shellcheck source=scripts/setup/lib/cogni-deployment-identity.sh
source "$REPO_ROOT/scripts/setup/lib/cogni-deployment-identity.sh"
# The renderer's own all-present check, loaded by itself (the script renders when sourced whole), so the
# negative cases below run the real function, never a missing command.
# shellcheck source=/dev/null
source <(sed -n '/^assert_mesh_vm_sites() {$/,/^}$/p' "$REPO_ROOT/scripts/ci/render-caddyfile.sh")
declare -F assert_mesh_vm_sites >/dev/null || fail "assert_mesh_vm_sites not loaded from render-caddyfile.sh"
# deploy-infra.sh calls `--domain "$DOMAIN"` only (frozen, untouched): the env derives from the domain.
CAND="$(bash scripts/ci/render-caddyfile.sh --domain test.cognidao.org)"
[ "$CAND" = "$(bash scripts/ci/render-caddyfile.sh --domain test.cognidao.org --env candidate-a)" ] \
  || fail "domain-derived env differs from explicit --env candidate-a"
[ "$(grep -c '^  local_certs$' <<<"$CAND")" = "1" ] || fail "global local_certs must stay for every proxied host"
vm_tailnets="$(mesh_vm_tailnets candidate-a | paste -sd' ' -)"
[ "$vm_tailnets" = "candidate-a test-candidate-a" ] \
  || fail "candidate-a VM must serve the canonical and the test-operator tailnets (got: $vm_tailnets)"
block_of() { awk -v h="$1 {" '$0 == h {p=1} p {print} p && /^}$/ {exit}' <<<"$2"; }
for tailnet in $vm_tailnets; do
  relay="$(mesh_host "$tailnet" relay)"
  rb="$(block_of "$relay" "$CAND")"
  [ -n "$rb" ] || fail "relay site $relay missing"
  grep -Fq 'issuer acme' <<<"$rb" || fail "$relay must use a public ACME issuer (DNS-only)"
  grep -Fq '@mesh path /derp /derp/* /generate_204' <<<"$rb" || fail "$relay must route only DERP paths"
  grep -Fq "reverse_proxy host.docker.internal:$(mesh_tailnet_field "$tailnet" relay_np)" <<<"$rb" \
    || fail "$relay upstream is not its relay NodePort"
  grep -Fq 'respond 404' <<<"$rb" || fail "$relay does not refuse other paths"
done
vm_host="$(cogni_vm_host_for_env candidate-a cognidao.org cogni)"
pb="$(block_of "$vm_host" "$CAND")"
[ -n "$pb" ] || fail "VM alias publish site $vm_host missing"
grep -Fq 'issuer acme' <<<"$pb" || fail "VM alias site must use a public ACME issuer (DNS-only)"
for tailnet in $vm_tailnets; do
  grep -Fq "handle /.well-known/cogni-mesh/${tailnet}/substrate-gw.json {" <<<"$pb" \
    || fail "publish path for $tailnet missing"
  grep -Fq "reverse_proxy host.docker.internal:$(mesh_tailnet_field "$tailnet" publish_np)" <<<"$pb" \
    || fail "publish upstream for $tailnet is not its publisher NodePort"
done
[ "$(grep -c 'handle /.well-known/cogni-mesh/' <<<"$pb")" = "2" ] || fail "VM alias must carry exactly the two publish paths"
# The one-writer check really fails when a tailnet's route is missing.
assert_mesh_vm_sites candidate-a "$CAND" || fail "the full candidate-a render must pass the all-present check"
if assert_mesh_vm_sites candidate-a "$(grep -v '^derp-test-candidate-a.cogni-testing.org {$' <<<"$CAND")" 2>/dev/null; then
  fail "a missing relay site must fail the render"
fi
if assert_mesh_vm_sites candidate-a "$(grep -v 'cogni-mesh/candidate-a/' <<<"$CAND")" 2>/dev/null; then
  fail "a missing publish path must fail the render"
fi
if assert_mesh_vm_sites candidate-a "$(grep -v '^mesh-test-candidate-a.cogni-testing.org {$' <<<"$CAND")" 2>/dev/null; then
  fail "a missing coordinator site must fail the render"
fi
grep -A3 'cogni-mesh/candidate-a/substrate-gw.json {' <<<"$CAND" | grep -Fq 'respond @write-candidate-a 405' \
  || fail "the publish path must accept only GET and HEAD"
# Coordinator sites: each env's edge fronts exactly its sequencer's tailnets, client paths only.
PROD="$(bash scripts/ci/render-caddyfile.sh --domain cognidao.org)"
for env in production candidate-a; do
  rendered="$PROD"; [ "$env" = candidate-a ] && rendered="$CAND"
  for tailnet in $(mesh_coordinator_tailnets "$env"); do
    host="$(mesh_host "$tailnet" control)"
    cb="$(block_of "$host" "$rendered")"
    [ -n "$cb" ] || fail "$env edge has no coordinator site for $host"
    grep -Fq 'issuer acme' <<<"$cb" || fail "$host must use a public ACME issuer (DNS-only)"
    grep -Fq '@mesh path /ts2021 /key /machine/* /verify' <<<"$cb" || fail "$host must route only client paths"
    grep -Fq "reverse_proxy host.docker.internal:$(mesh_tailnet_field "$tailnet" coordinator_np)" <<<"$cb" \
      || fail "$host upstream is not its coordinator NodePort"
    grep -Eq '/api|/register|/swagger|/health' <<<"$cb" && fail "$host exposes a Headscale admin or health path"
    grep -Fq 'respond 404' <<<"$cb" || fail "$host does not refuse other paths"
  done
done
[ "$(mesh_coordinator_tailnets production | paste -sd' ' -)" = "candidate-a preview production" ] \
  || fail "production's sequencer must front the canonical tailnets"
[ "$(mesh_coordinator_tailnets candidate-a | paste -sd' ' -)" = "test-candidate-a" ] \
  || fail "the candidate-a test operator must front only its own tailnet"
[ "$(mesh_host test-candidate-a control)" = "mesh-test-candidate-a.cogni-testing.org" ] \
  || fail "the test coordinator host must be in the test-fleet zone"
grep -Fq 'mesh-candidate-a.cognidao.org {' <<<"$CAND" && fail "candidate-a edge must not front the canonical candidate-a coordinator"
# T1p: the production VM serves the canonical production tailnet's relay + publisher. The edge site and the
# hardener drop land BEFORE the instance that opens the NodePorts (CD6: the drop precedes the ports).
[ "$(mesh_vm_tailnets production | paste -sd' ' -)" = "production" ] \
  || fail "the production VM must serve exactly the production tailnet"
pd="$(block_of derp-production.cognidao.org "$PROD")"
grep -Fq "reverse_proxy host.docker.internal:$(mesh_tailnet_field production relay_np)" <<<"$pd" \
  || fail "derp-production must proxy to the production derper NodePort"
grep -Fq 'handle /.well-known/cogni-mesh/production/substrate-gw.json {' <<<"$(block_of cogni.vm.cognidao.org "$PROD")" \
  || fail "the production VM alias must carry the production publish path"
assert_mesh_vm_sites production "$PROD" || fail "production render must carry every production mesh route"
# Every relay site and publish path on the production edge is the production tailnet's own: no other tailnet's.
[ "$(grep -E '^derp-' <<<"$PROD" | grep -vxF 'derp-production.cognidao.org {' || true)" = "" ] \
  || fail "production must render no relay site other than derp-production"
[ "$(grep -oE 'cogni-mesh/[a-z0-9-]+/' <<<"$PROD" | sort -u | grep -vxF 'cogni-mesh/production/' || true)" = "" ] \
  || fail "production must render no publish path other than the production tailnet's"
# T1p: the preview VM serves the canonical preview tailnet's relay + publisher (its coordinator runs in the
# production sequencer, so the preview edge fronts no control host). Edge site + hardener drop land BEFORE the
# instance that opens the NodePorts (CD6).
PREV="$(bash scripts/ci/render-caddyfile.sh --domain preview.cognidao.org)"
[ "$(mesh_vm_tailnets preview | paste -sd' ' -)" = "preview" ] \
  || fail "the preview VM must serve exactly the preview tailnet"
vd="$(block_of derp-preview.cognidao.org "$PREV")"
grep -Fq "reverse_proxy host.docker.internal:$(mesh_tailnet_field preview relay_np)" <<<"$vd" \
  || fail "derp-preview must proxy to the preview derper NodePort"
grep -Fq 'handle /.well-known/cogni-mesh/preview/substrate-gw.json {' <<<"$(block_of cogni-preview.vm.cognidao.org "$PREV")" \
  || fail "the preview VM alias must carry the preview publish path"
assert_mesh_vm_sites preview "$PREV" || fail "preview render must carry every preview mesh route"
[ "$(grep -E '^derp-' <<<"$PREV" | grep -vxF 'derp-preview.cognidao.org {' || true)" = "" ] \
  || fail "preview must render no relay site other than derp-preview"
[ "$(grep -oE 'cogni-mesh/[a-z0-9-]+/' <<<"$PREV" | sort -u | grep -vxF 'cogni-mesh/preview/' || true)" = "" ] \
  || fail "preview must render no publish path other than the preview tailnet's"
grep -Eq '^mesh-' <<<"$PREV" && fail "preview edge must front no coordinator (preview's runs in production)"
grep -Fq 'issuer acme' <<<"$RENDERED" && fail "template render must not carry env-specific mesh sites"
# Hardener drops exactly the table's edge-only NodePorts, before NAT, only after DOCKER-USER is complete.
HARDEN="infra/provision/cherry/harden-docker-public-ports.sh"
edge_only="$(sed -n 's/^MESH_EDGE_ONLY_PORTS="\(.*\)"$/\1/p' "$HARDEN")"
expanded=""
IFS=, read -r -a parts <<<"$edge_only"
for part in "${parts[@]}"; do
  if [[ "$part" == *:* ]]; then
    for ((p = ${part%:*}; p <= ${part#*:}; p++)); do expanded+="${expanded:+,}$p"; done
  else
    expanded+="${expanded:+,}$part"
  fi
done
[ "$expanded" = "$(mesh_edge_only_nodeports_csv)" ] \
  || fail "$HARDEN MESH_EDGE_ONLY_PORTS ($edge_only) != mesh-plane.sh edge-only NodePorts ($(mesh_edge_only_nodeports_csv))"
raw_line="$(grep -n -- '-t raw -A PREROUTING -i "$PUBLIC_IFACE" -p tcp -m multiport --dports "$MESH_EDGE_ONLY_PORTS"' "$HARDEN" | cut -d: -f1)"
drop_line="$(grep -n -- '--comment "$TAG:drop-public" -j DROP' "$HARDEN" | cut -d: -f1)"
[ -n "$raw_line" ] || fail "edge-only ports are not dropped before NAT"
[ "$raw_line" -gt "$drop_line" ] || fail "raw-table block must run after DOCKER-USER's public DROP (fail closed)"
grep -Fq 'MESH_UDP' "$HARDEN" && fail "no-op UDP ACCEPT rules must not return"
# Table invariants: unique ports and regions; NodePorts off the catalog 100-stride.
# Canonical tailnets in the production zone; the test operator's in the isolated test-fleet zone.
[ "$(mesh_host candidate-a relay)" = "derp-candidate-a.cognidao.org" ] || fail "canonical relay host must be in cognidao.org"
[ "$(mesh_host test-candidate-a relay)" = "derp-test-candidate-a.cogni-testing.org" ] \
  || fail "test-operator relay host must be in the test-fleet zone cogni-testing.org"
[ "$(mesh_host test-candidate-a control)" = "mesh-test-candidate-a.cogni-testing.org" ] \
  || fail "test-operator control host must be in the test-fleet zone cogni-testing.org"
# Relay-only with STUN off (P4): the mesh plane opens no public UDP port. The table has no STUN column,
# and substrate-gw's WireGuard port is pod-local (TS_PORT), so it may repeat across VMs.
mesh_tailnet_field candidate-a stun_port >/dev/null 2>&1 && fail "the tailnet table must carry no STUN port (STUN off)"
for col in coordinator_np relay_np publish_np derp_region; do
  vals="$(for t in $(mesh_tailnets); do mesh_tailnet_field "$t" "$col"; done | grep -v '^$')"
  [ "$(sort <<<"$vals" | uniq -d)" = "" ] || fail "duplicate $col in the mesh tailnet table"
done
for p in $(mesh_edge_only_nodeports_csv | tr , ' '); do
  [ $((p % 100)) -ne 0 ] || fail "edge-only NodePort $p sits on the catalog node_port stride"
done
# The frozen deploy brain is untouched by the mesh plane.
grep -Eq 'MESH_|mesh-plane' "$DEPLOY_INFRA" && fail "deploy-infra.sh must carry no mesh-plane logic"
pass "relay + publish routes for both candidate-a tailnets, coordinator sites per sequencer, one writer with an all-present check, hardened, deploy brain untouched"

echo "PASS: render-caddyfile.test.sh"
