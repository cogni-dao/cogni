#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# next-free-node-port.sh — allocate + guard the scarce k8s NodePort resource
# from infra/catalog/*.yaml (CATALOG_IS_SSOT, docs/spec/ci-cd.md axiom 16).
#
# node_port is the k3s Service NodePort (range 30000–32767) the edge Caddy
# reverse-proxies to (host.docker.internal:<node_port>). It MUST be unique per
# VM — two nodes sharing one NodePort makes kube-proxy route to one Service and
# silently blackhole the other. The values were hand-picked on a ~30x00 stride
# (operator 30000, node-template 30200, resy 30300, canary 30400); nothing
# asserted uniqueness or auto-allocated the next one. This helper does both:
#
#   next-free-node-port.sh           # print the next free port = max(node_port)+100
#                                     # (preserves the ~x00 stride). The scaffolder
#                                     # / node-birth wizard calls this when minting
#                                     # a new type:node catalog entry.
#
#   next-free-node-port.sh --check    # assert node_port is UNIQUE across the
#                                     # catalog; non-zero + diagnostic on a clash.
#                                     # Cross-file uniqueness is inexpressible in
#                                     # pure JSON-schema, so this runs alongside
#                                     # `check-jsonschema --schemafile _schema.json`.
#
# Only type:node entries carry node_port (type:service/infra have none); empty
# values are skipped. Range overflow (>32767) is a hard error.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/ci/lib/image-tags.sh
source "${SCRIPT_DIR}/lib/image-tags.sh"

NODE_PORT_MIN=30000
NODE_PORT_MAX=32767
NODE_PORT_STRIDE=100

# Emit "<target> <node_port>" for every catalog entry that declares a node_port.
_node_port_pairs() {
  local target port
  for target in "${ALL_TARGETS[@]}"; do
    port="${_image_tags_node_port_cache[$target]:-}"
    [ -n "$port" ] || continue
    printf '%s %s\n' "$target" "$port"
  done
}

check_unique() {
  local dupes
  dupes="$(_node_port_pairs | awk '{ port[$2] = port[$2] " " $1; n[$2]++ }
    END { for (p in n) if (n[p] > 1) printf "  node_port %s shared by:%s\n", p, port[p] }')"
  if [ -n "$dupes" ]; then
    echo "[ERROR] next-free-node-port: duplicate node_port in infra/catalog/*.yaml." >&2
    echo "        node_port is the per-VM k8s NodePort — it MUST be unique (CATALOG_IS_SSOT)." >&2
    echo "$dupes" >&2
    echo "        Pick the next free port: bash scripts/ci/next-free-node-port.sh" >&2
    exit 1
  fi
  echo "node_port is unique across the catalog."
}

next_free() {
  local max="" port
  while read -r _target port; do
    if [ -z "$max" ] || [ "$port" -gt "$max" ]; then
      max="$port"
    fi
  done < <(_node_port_pairs)

  local next
  if [ -z "$max" ]; then
    next="$NODE_PORT_MIN"
  else
    next=$((max + NODE_PORT_STRIDE))
  fi

  if [ "$next" -gt "$NODE_PORT_MAX" ]; then
    echo "[ERROR] next-free-node-port: next port $next exceeds the NodePort ceiling $NODE_PORT_MAX." >&2
    echo "        The ~x00 stride is exhausted; compact existing node_port values or widen the range." >&2
    exit 1
  fi
  printf '%s\n' "$next"
}

case "${1:-}" in
  --check)
    check_unique
    ;;
  "")
    next_free
    ;;
  *)
    echo "Usage: $0 [--check]" >&2
    exit 2
    ;;
esac
