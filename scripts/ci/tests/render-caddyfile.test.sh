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
#   8. task.5428 mesh plane: `--env` sites derive from committed declarations
#      (DNS-only ACME, client paths only, NodePorts dropped from the public NIC,
#      VM services scoped by infra/catalog/derper.yaml envs).
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

echo "[8/8] mesh plane sites are derived, DNS-only ACME, path-filtered and env-scoped (task.5428)"
# shellcheck source=scripts/ci/lib/mesh-plane.sh
source "$REPO_ROOT/scripts/ci/lib/mesh-plane.sh"
CAND="$(bash scripts/ci/render-caddyfile.sh --domain test.cognidao.org --env candidate-a)"
PROD="$(bash scripts/ci/render-caddyfile.sh --domain cognidao.org --env production)"
PREV="$(bash scripts/ci/render-caddyfile.sh --domain preview.cognidao.org --env preview)"
[ "$(grep -c '^  local_certs$' <<<"$PROD")" = "1" ] || fail "global local_certs must stay for every proxied host"
# candidate-a VM: relay + enrollment publish on its DNS-only alias, nothing else.
grep -Fq 'cogni-candidate-a.vm.cognidao.org {' <<<"$CAND" || fail "candidate-a VM relay/publish site missing"
grep -Fq '@mesh path /derp /derp/* /generate_204' <<<"$CAND" || fail "relay site must route only DERP paths"
grep -Fq 'reverse_proxy substrate-gw-publisher:8080' <<<"$CAND" || fail "enrollment publish route missing"
grep -Fq 'mesh-candidate-a.cognidao.org {' <<<"$CAND" && fail "candidate-a edge must not front the coordinators"
# production edge: one coordinator site per declared Headscale, client paths only, its NodePort.
lanes=0
while read -r lane; do
  lanes=$((lanes + 1))
  host="$(mesh_control_host_for_env "$lane")"; port="$(mesh_control_nodeport_for_env "$lane")"
  block="$(awk -v h="$host {" '$0 == h {p=1} p {print} p && /^}$/ {exit}' <<<"$PROD")"
  [ -n "$block" ] || fail "production edge has no site for $host"
  grep -Fq 'issuer acme' <<<"$block" || fail "$host must use a public ACME issuer (DNS-only host)"
  grep -Fq '@mesh path /ts2021 /key /machine/* /verify /health' <<<"$block" || fail "$host must route only client paths"
  grep -Fq "reverse_proxy host.docker.internal:$port" <<<"$block" || fail "$host upstream is not NodePort $port"
  grep -Eq '/api|/register|/swagger' <<<"$block" && fail "$host exposes a Headscale admin path"
  grep -Fq 'respond 404' <<<"$block" || fail "$host does not refuse other paths"
done < <(mesh_control_lanes)
[ "$lanes" = "3" ] || fail "expected coordinators for candidate-a, preview and production, found $lanes"
grep -Fq 'mesh-' <<<"$PREV" && fail "preview edge must render no mesh site yet (no relay row, no coordinator component)"
# Template mode (the committed drift-gated file) is unchanged by the mesh plane.
grep -Fq 'issuer acme' <<<"$RENDERED" && fail "template render must not carry env-specific mesh sites"
# Hardener drops exactly the declared coordinator NodePorts from the public NIC.
HARDEN="infra/provision/cherry/harden-docker-public-ports.sh"
declared="$(mesh_control_nodeports_csv)"
range="$(sed -n 's/^MESH_CONTROL_NODEPORTS="\([0-9]*\):\([0-9]*\)"$/\1 \2/p' "$HARDEN")"
read -r lo hi <<<"$range"
expanded=""; for ((p = lo; p <= hi; p++)); do expanded+="${expanded:+,}$p"; done
[ "$expanded" = "$declared" ] || fail "$HARDEN MESH_CONTROL_NODEPORTS ($range) != service.yaml NodePorts ($declared)"
grep -Fq -- '-t raw -A PREROUTING -i "$PUBLIC_IFACE" -p tcp -m multiport --dports "$MESH_CONTROL_NODEPORTS"' "$HARDEN" \
  || fail "coordinator NodePorts are not dropped before NAT"
# deploy-infra: catalog-scoped services + the env render.
[ "$(catalog_compose_services_for_env candidate-a)" = "derper substrate-gw substrate-gw-publisher mesh-control-fwd substrate-fwd" ] \
  || fail "candidate-a compose services: $(catalog_compose_services_for_env candidate-a)"
[ -z "$(catalog_compose_services_for_env production)" ] || fail "production must not start the VM mesh plane before slice T1p"
for svc in $(catalog_compose_services_for_env candidate-a); do
  yq -e ".services.\"$svc\"" "$RUNTIME_COMPOSE" >/dev/null || fail "catalog compose service '$svc' is not in $RUNTIME_COMPOSE"
done
grep -Fq 'render-caddyfile.sh" --domain "$DOMAIN" --env "$DEPLOY_ENVIRONMENT"' "$DEPLOY_INFRA" || fail "deploy-infra does not render the env's mesh sites"
grep -Fq 'INFRA_SERVICES="$INFRA_SERVICES ${CATALOG_COMPOSE_SERVICES:-}"' "$DEPLOY_INFRA" || fail "deploy-infra does not start catalog compose services"
pass "relay/publish on candidate-a VM, 3 coordinators on the production edge, NodePorts hardened, catalog-scoped services"

echo "PASS: render-caddyfile.test.sh"
