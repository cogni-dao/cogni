#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# render-network-nodes.sh — project the fleet catalog into the operator's committed web roster.
#
# The operator runtime image intentionally does not ship infra/catalog, so it needs a static roster.
# This renderer makes that projection reproducible for every fleet, including the isolated test parent.
# Ordering follows node_port, the catalog's stable fleet slot; the primary node is emitted explicitly.
#
# Usage: render-network-nodes.sh           # print the generated array
#        render-network-nodes.sh --write   # replace the committed array
#        render-network-nodes.sh --check   # fail when the committed projection is stale
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
CATALOG_DIR="$REPO_ROOT/infra/catalog"
ROSTER_PATH="$REPO_ROOT/nodes/operator/app/src/adapters/server/node-registry/network-nodes.data.ts"
ARRAY_OPEN="export const NETWORK_NODES: readonly NetworkNode[] = ["
ARRAY_CLOSE="];"

json_string() {
  jq -Rn --arg value "$1" '$value'
}

catalog_rows() {
  local file type name node_port source_repo node_id primary spec_path
  for file in "$CATALOG_DIR"/*.yaml; do
    type="$(yq -r '.type // ""' "$file")"
    [ "$type" = "node" ] || continue

    name="$(yq -r '.name // ""' "$file")"
    node_port="$(yq -r '.node_port // ""' "$file")"
    source_repo="$(yq -r '.source_repo // ""' "$file")"
    primary="$(yq -r '.is_primary_host // false' "$file")"
    [ -n "$name" ] || { echo "[ERROR] $file is type:node without name" >&2; exit 1; }
    [[ "$node_port" =~ ^[0-9]+$ ]] || {
      echo "[ERROR] $file is type:node without numeric node_port" >&2
      exit 1
    }

    if [ -n "$source_repo" ]; then
      node_id="$(yq -r '.node_id // ""' "$file")"
    else
      spec_path="$REPO_ROOT/nodes/$name/.cogni/repo-spec.yaml"
      [ -f "$spec_path" ] || {
        echo "[ERROR] in-repo node '$name' is missing $spec_path" >&2
        exit 1
      }
      node_id="$(yq -r '.node_id // ""' "$spec_path")"
    fi
    [ -n "$node_id" ] || {
      echo "[ERROR] node '$name' has no node_id in its identity source" >&2
      exit 1
    }

    printf '%s\t%s\t%s\t%s\n' "$node_port" "$name" "$node_id" "$primary"
  done | LC_ALL=C sort -t $'\t' -k1,1n -k2,2
}

render() {
  local _node_port name node_id primary quoted_name quoted_id
  printf '%s\n' "$ARRAY_OPEN"
  while IFS=$'\t' read -r _node_port name node_id primary; do
    quoted_name="$(json_string "$name")"
    quoted_id="$(json_string "$node_id")"
    if [ "$primary" = "true" ]; then
      printf '  {\n    name: %s,\n    nodeId: %s,\n    primary: true,\n  },\n' \
        "$quoted_name" "$quoted_id"
    else
      printf '  { name: %s, nodeId: %s },\n' "$quoted_name" "$quoted_id"
    fi
  done < <(catalog_rows)
  printf '%s\n' "$ARRAY_CLOSE"
}

committed_block() {
  awk -v begin="$ARRAY_OPEN" -v end="$ARRAY_CLOSE" '
    $0 == begin { grab = 1 }
    grab { print }
    grab && $0 == end { exit }
  ' "$ROSTER_PATH"
}

write() {
  local tmp block
  tmp="$(mktemp)"
  block="$(mktemp)"
  render > "$block"
  awk -v begin="$ARRAY_OPEN" -v end="$ARRAY_CLOSE" -v blockfile="$block" '
    $0 == begin {
      while ((getline line < blockfile) > 0) print line
      close(blockfile)
      skip = 1
      next
    }
    skip && $0 == end { skip = 0; next }
    skip { next }
    { print }
  ' "$ROSTER_PATH" > "$tmp"
  rm -f "$block"
  if ! grep -qF "$ARRAY_OPEN" "$tmp"; then
    echo "[ERROR] $ROSTER_PATH is missing the NETWORK_NODES array" >&2
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$ROSTER_PATH"
}

check() {
  if ! diff -u <(committed_block) <(render); then
    echo "[ERROR] $ROSTER_PATH is out of sync with infra/catalog" >&2
    echo "        Run: pnpm gen:network-nodes" >&2
    exit 1
  fi
  echo "network node roster is in sync with infra/catalog."
}

case "${1:-}" in
  --check) check ;;
  --write) write ;;
  "") render ;;
  *)
    echo "Usage: $0 [--check|--write]" >&2
    exit 2
    ;;
esac
