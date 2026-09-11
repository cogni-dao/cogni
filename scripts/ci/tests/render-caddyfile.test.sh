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

echo "[1/6] Caddyfile.tmpl ↔ catalog drift gate"
bash scripts/ci/render-caddyfile.sh --check >/dev/null \
  || fail "render-caddyfile.sh --check: committed Caddyfile.tmpl is stale (run: pnpm gen:caddyfile)"
pass "committed Caddyfile.tmpl matches the catalog"

echo "[2/6] every type:node has an edge block (catalog-driven, no node special-cased)"
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

echo "[3/6] catalog node_port == overlay Service nodePort (no split-brain)"
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

echo "[4/6] Caddy logs are collectible from container stdout"
stdout_loggers="$(grep -c 'output stdout' <<<"$RENDERED")"
expected_loggers="$(( ${#NODE_TARGETS[@]} + 1 ))"
[ "$stdout_loggers" = "$expected_loggers" ] \
  || fail "expected $expected_loggers stdout loggers (global + one/site), found $stdout_loggers"
if grep -q 'output file /data/logs/caddy' <<<"$RENDERED"; then
  fail "Caddy writes logs to its private /data volume; Alloy cannot collect them"
fi
pass "global + per-site JSON logs emit to stdout"

echo "[5/6] Alloy keeps edge saturation counters"
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

echo "[6/6] catalog node DB inventory includes every type:node"
dbs="$(node_database_csv)"
for node in "${NODE_TARGETS[@]}"; do
  expected_db="$(node_database_for_target "$node")"
  case ",$dbs," in
    *",$expected_db,"*) pass "$node -> $expected_db" ;;
    *) fail "derived DB inventory '$dbs' missing $expected_db for node '$node'" ;;
  esac
done

echo "PASS: render-caddyfile.test.sh"
