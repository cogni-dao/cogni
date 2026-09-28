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
# Output layout: per-(env, node) AppSet files live in infra/k8s/argocd/appsets/<env>/
#   alongside a GENERATED appsets/<env>/kustomization.yaml that lists that env's
#   AppSets. Each env dir is reconciled with prune by the PER-ENV cogni-<env>-appsets
#   app-of-apps, so removing a node from a catalog `envs[]` (→ its file leaves git)
#   auto-prunes the live AppSet — and no foreign env's AppSets fan onto a cluster.
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
# THE definition of the AppSet path + control env (bug.5204). Sourced, never re-derived.
# shellcheck source=scripts/ci/lib/appset-paths.sh
. "$SCRIPT_DIR/lib/appset-paths.sh"
# Single source of truth for the AppSet shape — shared byte-for-byte with the
# operator's TS node scaffolder (task.5092). Both interpolate __ENV__/__NODE__/__REPO_URL__.
TEMPLATE="$SCRIPT_DIR/node-applicationset.yaml.tmpl"
ENVS=(candidate-a preview production)

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

# The git repo that HOSTS this env's deploy/<env>-<node> branches — i.e. where the
# AppSet git generator + Application source resolve their revision. It is a property
# of the HOSTING FLEET, not of any node: the canonical cogni-dao fleet hosts every
# deploy branch in cogni-dao/cogni, so the default keeps every committed AppSet
# byte-identical (and `--check` green) there. An ISOLATED fleet (e.g. cogni-test-org)
# hosts a test-parent node's deploy branch in its OWN repo and overrides REPO_URL at
# render/apply time so Argo resolves the right repo (bug.5235) — the same
# default-preserving env-var idiom as FLEET_CONTROL_ENV (subtask.5007) and the
# ${FORK_REPO} substrate-app substitution (register-substrate-apps.sh).
REPO_URL="${REPO_URL:-https://github.com/cogni-dao/cogni.git}"

# Emit one ApplicationSet object for (env, node) by interpolating the shared
# template. __ENV__/__NODE__ and __REPO_URL__ are substituted; `{{.name}}` (Argo
# goTemplate) is left intact. Node/env slugs never contain `/`, so the `/` sed
# delimiter is safe for them; __REPO_URL__ carries `/` so it uses a `#` delimiter.
render_one() {
  local env="$1" node="$2"
  sed -e "s/__ENV__/$env/g" -e "s/__NODE__/$node/g" -e "s#__REPO_URL__#$REPO_URL#g" "$TEMPLATE"
}

env_dir() {
  printf '%s/%s\n' "$APPSETS_DIR" "$1"
}

# The (env, node) pairs whose AppSet file belongs in control dir "$1".
pairs_for_control_env() {
  local want="$1" env node
  for env in "${ENVS[@]}"; do
    for node in $(deployable_nodes_for_env "$env"); do
      [ "$(control_env_for "$env" "$node")" = "$want" ] || continue
      printf '%s %s\n' "$env" "$node"
    done
  done
}

# Absolute path; the repo-relative shape (and control_env_for) come from the lib so the
# renderer, the workflows and assert-target-substrate cannot drift (bug.5204).
appset_path() {
  printf '%s/%s\n' "$REPO_ROOT" "$(appset_rel_path "$1" "$2")"
}

kustomization_path() {
  printf '%s/%s/kustomization.yaml\n' "$APPSETS_DIR" "$1"
}

# The WHOLE appsets/<env>/kustomization.yaml: a self-contained kustomization
# (header + apiVersion + kind + namespace + resources) listing ONLY that env's
# per-node AppSet files (full <env>-<node>-applicationset.yaml names, in the same
# dir), node-sorted (LC_ALL=C). Sourced as a dir by the PER-ENV
# `cogni-<env>-appsets` app-of-apps; no bootstrap-splice sentinels.
render_kustomization() {
  local env="$1" penv pnode node
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
  # Lists the files in THIS CONTROL dir — which, for an akash node in a non-production
  # env, is the production dir rather than that env's own (task.5132).
  while read -r penv pnode; do
    [ -n "$penv" ] || continue
    printf '  - %s-%s-applicationset.yaml\n' "$penv" "$pnode"
  done <<< "$(pairs_for_control_env "$env")"
}

write_kustomization() {
  local env="$1"
  render_kustomization "$env" > "$(kustomization_path "$env")"
}

write() {
  local cenv env node count=0 pruned=0 committed base dir expected
  # Grouped by CONTROL env (which cluster's Argo owns the file), not by workload env.
  for cenv in "${ENVS[@]}"; do
    dir="$(env_dir "$cenv")"
    mkdir -p "$dir"
    expected=""
    while read -r env node; do
      [ -n "$env" ] || continue
      render_one "$env" "$node" > "$(appset_path "$env" "$node")"
      expected="$expected$(basename "$(appset_path "$env" "$node")")"$'\n'
      count=$((count + 1))
    done <<< "$(pairs_for_control_env "$cenv")"
    # Prune AppSets a node no longer claims (removed from its `envs:` set, or the
    # row left the catalog) within THIS env dir so `pnpm gen:node-appset` is
    # self-healing — and the per-env cogni-<env>-appsets app-of-apps then prunes
    # the live AppSet once the file leaves git.
    for committed in "$dir"/*-applicationset.yaml; do
      [ -e "$committed" ] || continue
      base="$(basename "$committed")"
      if ! grep -qxF "$base" <<<"$expected"; then
        rm -f "$committed"
        pruned=$((pruned + 1))
      fi
    done
    write_kustomization "$cenv"
  done
  echo "Wrote $count per-node ApplicationSet files (pruned $pruned stale) + per-env appsets kustomizations."
}

check() {
  local cenv env node path stale=0 expected committed base dir kpath
  for cenv in "${ENVS[@]}"; do
    dir="$(env_dir "$cenv")"
    expected=""
    while read -r env node; do
      [ -n "$env" ] || continue
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
    done <<< "$(pairs_for_control_env "$cenv")"
    # Stray file for a node no longer in the catalog (e.g. a closed birth-probe).
    # All files under appsets/<env>/ are renderer-owned — candidate-b and other
    # manually managed envs keep their own appset shape elsewhere, out of scope.
    for committed in "$dir"/*-applicationset.yaml; do
      [ -e "$committed" ] || continue
      base="$(basename "$committed")"
      if ! grep -qxF "$base" <<<"$expected"; then
        echo "[ERROR] $committed has no catalog row — stale AppSet; delete it." >&2
        stale=1
      fi
    done
    kpath="$(kustomization_path "$cenv")"
    if [ ! -f "$kpath" ]; then
      echo "[ERROR] missing $kpath — run: pnpm gen:node-appset" >&2
      stale=1
    elif ! diff -u "$kpath" <(render_kustomization "$cenv") >/dev/null; then
      echo "[ERROR] $kpath is out of sync with the catalog:" >&2
      diff -u "$kpath" <(render_kustomization "$cenv") >&2 || true
      stale=1
    fi
  done
  if [ "$stale" -ne 0 ]; then
    echo "        A node was added/removed without regenerating its AppSets (pnpm gen:node-appset)." >&2
    exit 1
  fi
  echo "per-node ApplicationSet files + per-env appsets kustomizations are in sync with the catalog."
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
