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
#   `candidate_a_branch` — i.e. the deployable Argo apps. `type: infra` rows
#   live on the VM/compose tier and never get an AppSet.
#
# Output layout: per-(env, node) AppSet files live in infra/k8s/argocd/appsets/<dir>/
#   alongside a GENERATED appsets/<dir>/kustomization.yaml that lists that dir's
#   AppSets. Each dir is reconciled with prune by ONE app-of-apps, so removing a node
#   from a catalog `envs[]` (→ its file leaves git) auto-prunes the live AppSet.
#
# <dir> is the environment whose CLUSTER reconciles the cell — NOT unconditionally the
#   cell's own environment (story.5016 seam 3, RECONCILIATION_FOLLOWS_PAYMENT). A cell
#   that is akash-placed AND owned by the `crossplane` authority must be reconciled where
#   the ONE production Akash writer lives, because the Composition builds that writer's
#   address from the XR's own namespace and the writer is ClusterIP-private. Such a
#   pre-prod cell renders into appsets/production-hosted-lanes/ instead, byte-identical
#   file name and byte-identical file body — only the app-of-apps that applies it differs.
#   Everything else (k3s rows, legacy-authority akash rows, every production row) keeps
#   landing in appsets/<env>/ exactly as before, so no foreign env's APP lane fans onto a
#   cluster. The rule lives in ONE reviewed place, mirrored here byte-for-byte:
#   nodes/operator/app/src/shared/node-registry/akash-lane-host.ts.
#
# Usage: render-node-appset.sh <env> <node>   # emit one object to stdout
#        render-node-appset.sh --write         # (re)write appsets/ files + kustomization
#        render-node-appset.sh --check         # fail if any committed file is stale
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Overridable so the unit test can point at a fixture catalog (task.5017).
CATALOG_DIR="${CATALOG_DIR:-$REPO_ROOT/infra/catalog}"
ARGOCD_DIR="$REPO_ROOT/infra/k8s/argocd"
# The per-(env, node) AppSets live under appsets/<env>/, each env dir reconciled
# with prune by its OWN per-env `cogni-<env>-appsets` app-of-apps
# (control-plane/<env>/<env>-appsets-application.yaml, itself reconciled by the
# `cogni-<env>-control-plane` root seed). Each appsets/<env>/kustomization.yaml is
# GENERATED WHOLESALE here (not a spliced block in the bootstrap kustomization),
# so a catalog-removed node's AppSet vanishes from git and Argo auto-prunes it —
# and a cluster only ever sources its OWN env's appsets/<env>/ dir.
APPSETS_DIR="$ARGOCD_DIR/appsets"
# Single source of truth for the AppSet shape — shared byte-for-byte with the
# operator's TS node scaffolder (task.5092). Both interpolate __ENV__/__NODE__.
TEMPLATE="$SCRIPT_DIR/node-applicationset.yaml.tmpl"
ENVS=(candidate-a preview production)
# RECONCILIATION_FOLLOWS_PAYMENT (story.5016 seam 3). Twin of the constants in
# src/shared/node-registry/akash-lane-host.ts — asserted in both directions by
# tests/ci-invariants/akash-lane-host.spec.ts.
AKASH_LANE_HOST_ENV=production
HOSTED_LANE_APPSETS_DIR=production-hosted-lanes
# Every directory this renderer OWNS: one per env, plus the production-hosted lane dir.
DIRS=("${ENVS[@]}" "$HOSTED_LANE_APPSETS_DIR")

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

# Deployable node slugs whose per-env node-set (`envs:`) includes $1, sorted.
# task.5017 — deploy ⊆ provisioned: an env only deploys the nodes that list it.
# A deployable row that omits `envs` (schema-required) is a hard error, not a
# silent all-env fallback — fail loud so a missing field can't fan out to a VM
# that never provisioned the node.
deployable_nodes_for_env() {
  local env="$1" f name envs
  for f in "$CATALOG_DIR"/*.yaml; do
    [ "$(yq -r '.candidate_a_branch // ""' "$f")" != "" ] || continue
    name="$(yq -r '.name' "$f")"
    if [ "$(yq -r 'has("envs")' "$f")" != "true" ]; then
      echo "[ERROR] $f is deployable but has no 'envs' node-set (CATALOG_IS_SSOT)." >&2
      exit 1
    fi
    # Capture into a here-string first: `yq | grep -q` would SIGPIPE yq the moment
    # grep matches, and `set -o pipefail` would surface that 141 as failure —
    # silently skipping the very nodes that DO claim the env.
    envs="$(yq -r '.envs[]' "$f")"
    grep -qxF "$env" <<<"$envs" || continue
    printf '%s\n' "$name"
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

# WHICH cluster's app-of-apps reconciles (env, node) — i.e. which appsets/<dir>/ the
# file belongs in. Byte-for-byte twin of `appsetsDirForLane` in
# src/shared/node-registry/akash-lane-host.ts; that module carries the full rationale.
#
# A cell is hosted by production iff it is akash-placed AND crossplane-owned AND not
# already production. BOTH catalog cells are required: the legacy compute authority is not
# cluster-bound the way the Crossplane Composition is (which derives the writer's address
# from the XR's own namespace), and a k3s row has no Akash writer to reach at all. So every
# non-(akash+crossplane) row keeps its existing home and renders byte-identically. The
# defaults mirror K3S_IS_DEFAULT / LEGACY_IS_DEFAULT.
appsets_dir_for_cell() {
  local env="$1" node="$2" catalog_file provider authority
  if [ "$env" = "$AKASH_LANE_HOST_ENV" ]; then
    printf '%s\n' "$env"
    return
  fi
  catalog_file="$CATALOG_DIR/$node.yaml"
  provider="$(E="$env" yq -r '(.deployment_provider // {})[strenv(E)] // "k3s"' "$catalog_file")"
  authority="$(E="$env" yq -r '(.compute_api // {})[strenv(E)] // "legacy"' "$catalog_file")"
  if [ "$provider" = "akash" ] && [ "$authority" = "crossplane" ]; then
    printf '%s\n' "$HOSTED_LANE_APPSETS_DIR"
  else
    printf '%s\n' "$env"
  fi
}

# The cells routed to directory $1, one `<file> <env> <node>` record per line, ordered by
# rendered FILE NAME (LC_ALL=C). For an env dir the `<env>-` prefix is constant, so this is
# the same node-sorted order the per-env renderer always produced. The hosted-lane dir holds
# cells from more than one env, so sorting on the file name is what keeps it deterministic.
cells_for_dir() {
  local want="$1" env node
  for env in "${ENVS[@]}"; do
    for node in $(deployable_nodes_for_env "$env"); do
      [ "$(appsets_dir_for_cell "$env" "$node")" = "$want" ] || continue
      printf '%s-%s-applicationset.yaml %s %s\n' "$env" "$node" "$env" "$node"
    done
  done | LC_ALL=C sort
}

dir_path() {
  printf '%s/%s\n' "$APPSETS_DIR" "$1"
}

kustomization_path() {
  printf '%s/%s/kustomization.yaml\n' "$APPSETS_DIR" "$1"
}

# The WHOLE appsets/<dir>/kustomization.yaml: a self-contained kustomization
# (header + apiVersion + kind + namespace + resources) listing ONLY the AppSet files
# that directory owns (full <env>-<node>-applicationset.yaml names, in the same dir),
# file-name-sorted (LC_ALL=C). Sourced as a dir by exactly ONE app-of-apps; no
# bootstrap-splice sentinels.
#
# The header differs for the hosted-lane dir because its reader needs a different fact:
# an env dir is applied by that env's own cluster, whereas production-hosted-lanes/ is
# applied by the PRODUCTION cluster on another env's behalf. The env-dir header is
# byte-identical to what it has always been, so every committed env kustomization is
# unchanged by seam 3.
render_kustomization() {
  local dir="$1" file
  if [ "$dir" = "$HOSTED_LANE_APPSETS_DIR" ]; then
    cat <<'EOF'
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# GENERATED by scripts/ci/render-node-appset.sh — DO NOT EDIT BY HAND.
# Per-(env, node) ApplicationSets the PRODUCTION cluster reconciles on ANOTHER env's behalf —
# the akash+crossplane lanes (story.5016 seam 3). Applied with prune by the
# cogni-production-hosted-lane-appsets app-of-apps
# (../../control-plane/production/production-hosted-lane-appsets-application.yaml).
# Each AppSet is byte-identical to the one its own env would have rendered; only the
# app-of-apps that applies it differs. Regenerate: pnpm gen:node-appset
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: argocd

resources:
EOF
  else
    cat <<'EOF'
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# GENERATED by scripts/ci/render-node-appset.sh — DO NOT EDIT BY HAND.
# This env's per-node ApplicationSets, reconciled with prune by the per-env
# cogni-<env>-appsets app-of-apps (../../control-plane/<env>/<env>-appsets-application.yaml).
# One AppSet per (env, node) for structural LANE_ISOLATION (axiom 18). Regenerate: pnpm gen:node-appset
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

namespace: argocd

resources:
EOF
  fi
  while read -r file _cell_env _cell_node; do
    [ -n "$file" ] || continue
    printf '  - %s\n' "$file"
  done < <(cells_for_dir "$dir")
}

write_kustomization() {
  local dir="$1"
  render_kustomization "$dir" > "$(kustomization_path "$dir")"
}

write() {
  local dir file cell_env cell_node count=0 pruned=0 committed base path expected
  for dir in "${DIRS[@]}"; do
    path="$(dir_path "$dir")"
    mkdir -p "$path"
    expected=""
    while read -r file cell_env cell_node; do
      [ -n "$file" ] || continue
      render_one "$cell_env" "$cell_node" > "$path/$file"
      expected="$expected$file"$'\n'
      count=$((count + 1))
    done < <(cells_for_dir "$dir")
    # Prune AppSets this directory no longer owns — a node removed from its `envs:` set,
    # a row that left the catalog, OR a cell whose reconciling cluster changed (a placement
    # flip to akash+crossplane moves the file between dirs). `pnpm gen:node-appset` is
    # therefore self-healing, and the owning app-of-apps prunes the live AppSet once the
    # file leaves git. ONE_CLUSTER_PER_CELL holds by construction: the same run that adds
    # the file under its new dir deletes it from the old one.
    for committed in "$path"/*-applicationset.yaml; do
      [ -e "$committed" ] || continue
      base="$(basename "$committed")"
      if ! grep -qxF "$base" <<<"$expected"; then
        rm -f "$committed"
        pruned=$((pruned + 1))
      fi
    done
    write_kustomization "$dir"
  done
  echo "Wrote $count per-node ApplicationSet files (pruned $pruned stale) + per-dir appsets kustomizations."
}

check() {
  local dir file cell_env cell_node stale=0 expected committed base path appset kpath
  for dir in "${DIRS[@]}"; do
    path="$(dir_path "$dir")"
    expected=""
    while read -r file cell_env cell_node; do
      [ -n "$file" ] || continue
      appset="$path/$file"
      expected="$expected$file"$'\n'
      if [ ! -f "$appset" ]; then
        echo "[ERROR] missing $appset — run: pnpm gen:node-appset" >&2
        stale=1
        continue
      fi
      if ! diff -u "$appset" <(render_one "$cell_env" "$cell_node") >/dev/null; then
        echo "[ERROR] $appset is out of sync with the catalog:" >&2
        diff -u "$appset" <(render_one "$cell_env" "$cell_node") >&2 || true
        stale=1
      fi
    done < <(cells_for_dir "$dir")
    # Stray file for a node no longer in the catalog (e.g. a closed birth-probe), or a cell
    # this directory no longer reconciles. All files under appsets/<dir>/ are renderer-owned
    # — candidate-b and other manually managed envs keep their own appset shape elsewhere,
    # out of scope.
    for committed in "$path"/*-applicationset.yaml; do
      [ -e "$committed" ] || continue
      base="$(basename "$committed")"
      if ! grep -qxF "$base" <<<"$expected"; then
        echo "[ERROR] $committed is not reconciled from this directory — stale or mis-homed AppSet; run: pnpm gen:node-appset" >&2
        stale=1
      fi
    done
    kpath="$(kustomization_path "$dir")"
    if [ ! -f "$kpath" ]; then
      echo "[ERROR] missing $kpath — run: pnpm gen:node-appset" >&2
      stale=1
    elif ! diff -u "$kpath" <(render_kustomization "$dir") >/dev/null; then
      echo "[ERROR] $kpath is out of sync with the catalog:" >&2
      diff -u "$kpath" <(render_kustomization "$dir") >&2 || true
      stale=1
    fi
  done
  if [ "$stale" -ne 0 ]; then
    echo "        A node was added/removed/rehomed without regenerating its AppSets (pnpm gen:node-appset)." >&2
    exit 1
  fi
  echo "per-node ApplicationSet files + per-dir appsets kustomizations are in sync with the catalog."
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
