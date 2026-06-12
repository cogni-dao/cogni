#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# render-scope-filters.sh — emit the `single-node-scope` dorny/paths-filter
# block from the `nodes/*` directory listing (CATALOG_IS_SSOT, axiom 16).
#
# The single-node-scope gate used to hand-list one `<slug>:` filter + one
# `!nodes/<slug>/**` operator negation per node, with single-node-scope-meta.spec.ts
# as a tripwire that failed if you forgot. Adding a node was a manual 2-spot edit.
# This generator loops the on-disk `nodes/*` listing (minus operator) instead, so
# a node formation (a new `nodes/<slug>/` dir) yields its filter + negation for free.
#
# `dorny/paths-filter` needs the filter inline in the workflow, so this script
# generate-and-commits the region of `.github/workflows/ci.yaml` between the
# `# >>> GENERATED scope-filters` / `# <<< GENERATED scope-filters` sentinels.
# `nodes/*` (not catalog type:node) is the SSOT because the gate keys on the
# directory layout the parity tests read; classify.ts + single-node-scope-meta.spec.ts
# agree with this same listing.
#
# Usage: render-scope-filters.sh            # write the filter block to stdout
#        render-scope-filters.sh --write    # splice the block into ci.yaml in place
#        render-scope-filters.sh --check    # fail if ci.yaml's block is stale
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NODES_DIR="$REPO_ROOT/nodes"
WORKFLOW_PATH="$REPO_ROOT/.github/workflows/ci.yaml"
OPERATOR_NODE="operator"
BEGIN="# >>> GENERATED scope-filters (scripts/ci/render-scope-filters.sh) — DO NOT EDIT BY HAND"
END="# <<< GENERATED scope-filters"
# Indent of the filter body inside the `filters: |` literal block (12 spaces).
INDENT="            "

# Non-operator node slugs, sorted. The `nodes/*` directory listing is the SSOT.
#
# Remote-source nodes live in their own repos and are absent under nodes/ (no
# gitlink, no .gitmodules). The single-node-scope domains are exactly the in-tree
# nodes/* directories minus operator. Stays in lockstep with
# single-node-scope-meta.spec.ts's listNonOperatorNodes().
non_operator_nodes() {
  local d
  for d in "$NODES_DIR"/*/; do
    d="$(basename "$d")"
    [ "$d" = "$OPERATOR_NODE" ] && continue
    printf '%s\n' "$d"
  done | LC_ALL=C sort
}

# Emit the filter body (sentinel markers + per-node filters + operator `**` and
# negations), each line prefixed with the in-YAML indent.
render() {
  local nodes node
  mapfile -t nodes < <(non_operator_nodes)

  printf '%s%s\n' "$INDENT" "$BEGIN"
  for node in "${nodes[@]}"; do
    printf '%s%s:\n' "$INDENT" "$node"
    printf "%s  - 'nodes/%s/**'\n" "$INDENT" "$node"
  done
  printf '%s%s:\n' "$INDENT" "$OPERATOR_NODE"
  printf "%s  - '**'\n" "$INDENT"
  for node in "${nodes[@]}"; do
    printf "%s  - '!nodes/%s/**'\n" "$INDENT" "$node"
  done
  printf '%s%s\n' "$INDENT" "$END"
}

# Splice the rendered block into ci.yaml, replacing whatever currently sits
# between the sentinel lines. awk reads the freshly rendered block from a file
# (portable across BSD/dev + GNU/CI awk — a multiline `-v` var is rejected by
# BSD awk), drops the old region inclusive of both sentinels, and injects the
# new block at the BEGIN marker.
write() {
  local tmp block
  tmp="$(mktemp)"
  block="$(mktemp)"
  render > "$block"
  awk -v begin="$BEGIN" -v end="$END" -v blockfile="$block" '
    index($0, begin) {
      while ((getline line < blockfile) > 0) print line
      close(blockfile)
      skip = 1
      next
    }
    skip && index($0, end) { skip = 0; next }
    skip { next }
    { print }
  ' "$WORKFLOW_PATH" > "$tmp"
  rm -f "$block"
  if ! grep -qF "$BEGIN" "$tmp"; then
    echo "[ERROR] $WORKFLOW_PATH is missing the '$BEGIN' sentinel; cannot splice." >&2
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$WORKFLOW_PATH"
}

# Extract the committed block (sentinel-to-sentinel, inclusive) for diffing.
committed_block() {
  awk -v begin="$BEGIN" -v end="$END" '
    index($0, begin) { grab = 1 }
    grab { print }
    grab && index($0, end) { exit }
  ' "$WORKFLOW_PATH"
}

check() {
  if ! grep -qF "$BEGIN" "$WORKFLOW_PATH"; then
    echo "[ERROR] $WORKFLOW_PATH is missing the scope-filters sentinels." >&2
    echo "        Wrap the dorny filter block with the GENERATED markers and run: pnpm gen:scope-filters" >&2
    exit 1
  fi
  if ! diff -u <(committed_block) <(render); then
    echo "[ERROR] $WORKFLOW_PATH single-node-scope filters are out of sync with nodes/*." >&2
    echo "        A node was added/removed under nodes/ without regenerating the gate." >&2
    echo "        Run: pnpm gen:scope-filters" >&2
    exit 1
  fi
  echo "single-node-scope filters are in sync with nodes/*."
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
