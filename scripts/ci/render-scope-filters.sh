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
# `dorny/paths-filter` accepts a multiline step output, so the workflow invokes
# this script at runtime and passes the generated YAML directly to the action.
# The workflow stays byte-identical across the hub and test-parent mirror while
# each checkout classifies its own `nodes/*` roster. No generated roster state is
# committed and no sync repair hand-edits workflow YAML.
# `nodes/*` (not catalog type:node) is the SSOT because the gate keys on the
# directory layout the parity tests read; classify.ts + single-node-scope-meta.spec.ts
# agree with this same listing.
#
# Usage: render-scope-filters.sh                 # write filter YAML to stdout
#        render-scope-filters.sh --github-output # write filters=... to $GITHUB_OUTPUT
#        render-scope-filters.sh --check         # verify workflow runtime wiring
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

NODES_DIR="$REPO_ROOT/nodes"
WORKFLOW_PATH="$REPO_ROOT/.github/workflows/ci.yaml"
OPERATOR_NODE="operator"

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

# Emit the dorny filter YAML: per-node filters plus operator `**` and negations.
render() {
  local nodes node
  mapfile -t nodes < <(non_operator_nodes)

  for node in "${nodes[@]}"; do
    printf '%s:\n' "$node"
    printf "  - 'nodes/%s/**'\n" "$node"
  done
  printf '%s:\n' "$OPERATOR_NODE"
  printf "  - '**'\n"
  for node in "${nodes[@]}"; do
    printf "  - '!nodes/%s/**'\n" "$node"
  done
}

# GitHub Actions multiline output consumed by dorny/paths-filter. The delimiter
# is fixed because node slugs cannot contain it and the rendered body contains
# only slugs plus path punctuation.
write_github_output() {
  : "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required for --github-output}"
  {
    echo "filters<<COGNI_SCOPE_FILTERS_EOF"
    render
    echo "COGNI_SCOPE_FILTERS_EOF"
  } >> "$GITHUB_OUTPUT"
}

check() {
  local rendered expected_nodes actual_nodes expected_operator actual_operator node
  if ! grep -qF 'run: bash scripts/ci/render-scope-filters.sh --github-output' "$WORKFLOW_PATH" \
    || ! grep -qF 'filters: ${{ steps.scope_filters.outputs.filters }}' "$WORKFLOW_PATH"; then
    echo "[ERROR] $WORKFLOW_PATH does not consume runtime-generated scope filters." >&2
    echo "        Keep the scope_filters step and pass its output to dorny/paths-filter." >&2
    exit 1
  fi
  rendered="$(render)"
  expected_nodes="$(non_operator_nodes)"
  actual_nodes="$(yq -r 'keys | .[] | select(. != "operator")' <<<"$rendered")"
  if [ "$actual_nodes" != "$expected_nodes" ]; then
    echo "[ERROR] rendered scope-filter keys do not match nodes/* minus operator." >&2
    exit 1
  fi
  expected_operator="**"
  for node in $expected_nodes; do
    if [ "$(NODE="$node" yq -r '.[strenv(NODE)][]' <<<"$rendered")" != "nodes/$node/**" ]; then
      echo "[ERROR] rendered scope filter for '$node' is not its exact nodes/$node/** path." >&2
      exit 1
    fi
    expected_operator="$expected_operator"$'\n'"!nodes/$node/**"
  done
  actual_operator="$(yq -r '.operator[]' <<<"$rendered")"
  if [ "$actual_operator" != "$expected_operator" ]; then
    echo "[ERROR] operator scope must be '**' plus one negation per non-operator node." >&2
    exit 1
  fi
  echo "single-node-scope runtime wiring is healthy."
}

case "${1:-}" in
  --check) check ;;
  --github-output) write_github_output ;;
  "") render ;;
  *)
    echo "Usage: $0 [--check|--github-output]" >&2
    exit 2
    ;;
esac
