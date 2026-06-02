#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# render-node-appset.sh — emit one Argo CD ApplicationSet object *per (env, node)*
# from the catalog (CATALOG_IS_SSOT, axiom 16; LANE_ISOLATION, axiom 18).
#
# Why per-node, not one shared AppSet per env:
#   The retired `<env>-applicationset.yaml` carried every node's generator in a
#   single object. A flight's reconcile-appset re-applied that whole file from the
#   flighted PR's head_sha — so a concurrent flight whose head lacked a pre-merge
#   node's generator pruned that node's Application (pod → 000). See
#   bug.0378.reconcile-appset-shared-write-race. Splitting into one AppSet object
#   per node makes the isolation STRUCTURAL: a flight only ever applies its own
#   node's file and literally cannot reference another lane's object.
#
# Node-set SSOT: catalog entries (`infra/catalog/<name>.yaml`) that declare a
#   `candidate_a_branch` — i.e. the deployable Argo apps (operator, resy,
#   scheduler-worker, node-template, canary). `type: infra` rows (litellm) live on
#   the VM/compose tier and never get an AppSet.
#
# Usage: render-node-appset.sh <env> <node>   # emit one object to stdout
#        render-node-appset.sh --write         # (re)write all per-node files
#        render-node-appset.sh --check         # fail if any committed file is stale
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

CATALOG_DIR="$REPO_ROOT/infra/catalog"
ARGOCD_DIR="$REPO_ROOT/infra/k8s/argocd"
KUSTOMIZATION="$ARGOCD_DIR/kustomization.yaml"
# Single source of truth for the AppSet shape — shared byte-for-byte with the
# operator's TS node scaffolder (task.5092). Both interpolate __ENV__/__NODE__.
TEMPLATE="$SCRIPT_DIR/node-applicationset.yaml.tmpl"
ENVS=(candidate-a preview production)
KBEGIN="  # >>> GENERATED node-appsets (scripts/ci/render-node-appset.sh) — DO NOT EDIT BY HAND"
KEND="  # <<< GENERATED node-appsets"

# Deployable node slugs, sorted. A catalog row with a `candidate_a_branch` is an
# Argo app; everything else (type: infra) is VM/compose tier. yq (not grep) so the
# TS scaffolder's YAML-parsed extraction can't skew against this drift gate.
deployable_nodes() {
  local f
  for f in "$CATALOG_DIR"/*.yaml; do
    [ "$(yq -r '.candidate_a_branch // ""' "$f")" != "" ] || continue
    yq -r '.name' "$f"
  done | LC_ALL=C sort
}

# Emit one ApplicationSet object for (env, node) by interpolating the shared
# template. Only __ENV__ and __NODE__ are substituted; `{{.name}}` (Argo
# goTemplate) is left intact. Node/env slugs never contain `/`, so the sed
# delimiter is safe.
render_one() {
  local env="$1" node="$2"
  sed -e "s/__ENV__/$env/g" -e "s/__NODE__/$node/g" "$TEMPLATE"
}

appset_path() {
  printf '%s/%s-%s-applicationset.yaml\n' "$ARGOCD_DIR" "$1" "$2"
}

# The bootstrap kustomization resources list, sorted to match `ls` order, each
# line as a kustomize `- <file>` entry between the GENERATED sentinels.
render_kustomization_block() {
  local env node
  printf '%s\n' "$KBEGIN"
  for env in "${ENVS[@]}"; do
    for node in $(deployable_nodes); do
      printf '  - %s-%s-applicationset.yaml\n' "$env" "$node"
    done
  done
  printf '%s\n' "$KEND"
}

# Splice render_kustomization_block into kustomization.yaml between sentinels.
write_kustomization() {
  local tmp block
  tmp="$(mktemp)"
  block="$(mktemp)"
  render_kustomization_block > "$block"
  awk -v begin="$KBEGIN" -v end="$KEND" -v blockfile="$block" '
    index($0, begin) {
      while ((getline line < blockfile) > 0) print line
      close(blockfile)
      skip = 1
      next
    }
    skip && index($0, end) { skip = 0; next }
    skip { next }
    { print }
  ' "$KUSTOMIZATION" > "$tmp"
  rm -f "$block"
  if ! grep -qF "$KBEGIN" "$tmp"; then
    echo "[ERROR] $KUSTOMIZATION is missing the node-appsets sentinels." >&2
    rm -f "$tmp"
    exit 1
  fi
  mv "$tmp" "$KUSTOMIZATION"
}

committed_kustomization_block() {
  awk -v begin="$KBEGIN" -v end="$KEND" '
    index($0, begin) { grab = 1 }
    grab { print }
    grab && index($0, end) { exit }
  ' "$KUSTOMIZATION"
}

write() {
  local env node count=0
  for env in "${ENVS[@]}"; do
    for node in $(deployable_nodes); do
      render_one "$env" "$node" > "$(appset_path "$env" "$node")"
      count=$((count + 1))
    done
  done
  write_kustomization
  echo "Wrote $count per-node ApplicationSet files + bootstrap kustomization."
}

check() {
  local env node path stale=0 expected="" committed
  for env in "${ENVS[@]}"; do
    for node in $(deployable_nodes); do
      path="$(appset_path "$env" "$node")"
      expected="$expected$(basename "$path")"$'\n'
      if [ ! -f "$path" ]; then
        echo "[ERROR] missing $path — run: pnpm gen:node-appset" >&2
        stale=1
        continue
      fi
      if ! diff -u "$path" <(render_one "$env" "$node") >/dev/null; then
        echo "[ERROR] $path is out of sync with the catalog:" >&2
        diff -u "$path" <(render_one "$env" "$node") >&2 || true
        stale=1
      fi
    done
  done
  # Stray file for a node no longer in the catalog (e.g. a closed birth-probe).
  # Scoped to the envs this renderer owns — candidate-b and other manually
  # managed envs keep their own appset shape and are out of scope here.
  local base env_owned
  for committed in "$ARGOCD_DIR"/*-applicationset.yaml; do
    [ -e "$committed" ] || continue
    base="$(basename "$committed")"
    env_owned=0
    for env in "${ENVS[@]}"; do
      case "$base" in "$env"-*) env_owned=1 ;; esac
    done
    [ "$env_owned" -eq 1 ] || continue
    if ! grep -qxF "$base" <<<"$expected"; then
      echo "[ERROR] $committed has no catalog row — stale AppSet; delete it." >&2
      stale=1
    fi
  done
  if ! diff -u <(committed_kustomization_block) <(render_kustomization_block) >/dev/null; then
    echo "[ERROR] $KUSTOMIZATION node-appsets list is out of sync with the catalog:" >&2
    diff -u <(committed_kustomization_block) <(render_kustomization_block) >&2 || true
    stale=1
  fi
  if [ "$stale" -ne 0 ]; then
    echo "        A node was added/removed without regenerating its AppSets (pnpm gen:node-appset)." >&2
    exit 1
  fi
  echo "per-node ApplicationSet files + bootstrap kustomization are in sync with the catalog."
}

case "${1:-}" in
  --check) check ;;
  --write) write ;;
  "")
    echo "Usage: $0 [--check|--write] | $0 <env> <node>" >&2
    exit 2
    ;;
  *)
    [ -n "${2:-}" ] || { echo "Usage: $0 <env> <node>" >&2; exit 2; }
    render_one "$1" "$2"
    ;;
esac
