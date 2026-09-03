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
#   4. The derived node DB inventory includes every catalog node.
#   5. Controller metrics use the host-only scrape seam and never an edge route.
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

echo "[1/5] Caddyfile.tmpl ↔ catalog drift gate"
bash scripts/ci/render-caddyfile.sh --check >/dev/null \
  || fail "render-caddyfile.sh --check: committed Caddyfile.tmpl is stale (run: pnpm gen:caddyfile)"
pass "committed Caddyfile.tmpl matches the catalog"

echo "[2/5] every type:node has an edge block (catalog-driven, no node special-cased)"
RENDERED="$(bash scripts/ci/render-caddyfile.sh)"
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

echo "[3/5] catalog node_port == overlay Service nodePort (no split-brain)"
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

echo "[4/5] catalog node DB inventory includes every type:node"
dbs="$(node_database_csv)"
for node in "${NODE_TARGETS[@]}"; do
  expected_db="$(node_database_for_target "$node")"
  case ",$dbs," in
    *",$expected_db,"*) pass "$node -> $expected_db" ;;
    *) fail "derived DB inventory '$dbs' missing $expected_db for node '$node'" ;;
  esac
done

echo "[5/5] controller metrics are scraped but not edge-routed"
controller_service="infra/k8s/base/compute-workload-controller/service.yaml"
controller_kustomization="infra/k8s/base/compute-workload-controller/kustomization.yaml"
alloy_config="infra/compose/runtime/configs/alloy-config.metrics.alloy"
firewall="infra/provision/cherry/harden-docker-public-ports.sh"
compute_allowlist="scripts/ci/render-compute-egress-allowlist.sh"

yq -e '
  .kind == "Service" and
  .metadata.name == "compute-workload-controller" and
  .spec.type == "NodePort"
' "$controller_service" >/dev/null || fail "controller metrics Service contract drifted"
metrics_port="$(yq -r '.spec.ports[] | select(.name == "metrics") | [.port, .targetPort, .nodePort] | join(":")' "$controller_service")"
[ "$metrics_port" = "9090:metrics:30901" ] \
  || fail "controller metrics port contract drifted: ${metrics_port:-missing}"
grep -Fq '  - service.yaml' "$controller_kustomization" \
  || fail "controller metrics Service is absent from the kustomize base"
grep -Fq 'targets         = [{"__address__" = "host.docker.internal:30901"}]' "$alloy_config" \
  || fail "Alloy does not scrape controller NodePort 30901"
grep -Eq '^PUBLIC_DROP_PORTS="\$\{INTERNAL_PORTS\},30901"$' "$firewall" \
  || fail "controller metrics NodePort 30901 is not denied on the public interface"
grep -Fq -- '--dports "$PUBLIC_DROP_PORTS"' "$firewall" \
  || fail "public DROP rule does not consume the controller metrics deny set"
if grep -Eq '^INTERNAL_PORTS="[0-9,]*30901([,\"]|$)' "$firewall"; then
  fail "bare external-compute allowlist entries must never inherit metrics port 30901"
fi
if grep -Eq '^SUBSTRATE_PORTS="[0-9,]*30901([,\"]|$)' "$compute_allowlist"; then
  fail "external compute allowlist must not grant controller metrics access"
fi
if grep -Eq '(^|[^0-9])30901([^0-9]|$)' <<<"$RENDERED"; then
  fail "controller metrics NodePort 30901 must never be edge-routed"
fi
pass "controller :9090 → NodePort 30901 → Alloy; firewall denied + no Caddy route"

echo "PASS: render-caddyfile.test.sh"
