#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# appset-paths.sh — THE definition of where a node's per-(env, node) ApplicationSet lives.
#
# WHY THIS IS A LIB AND NOT A STRING EACH CALLER BUILDS (task.5132, bug.5204):
# the path encodes TWO different questions that used to be one value —
#   WHICH ENV THE WORKLOAD IS  -> the filename `<env>-<node>-applicationset.yaml`
#   WHICH CLUSTER RECONCILES IT -> the directory `appsets/<control-env>/`
# For an akash node's non-production lane those differ: the node app runs on AKASH, not in
# any cluster, so its XR is pure desired state and the PRODUCTION cluster reconciles it
# ("the production operator controls test, preview AND production deployments for every
# node"). k3s rows genuinely run IN their env's cluster and stay there.
#
# Six callers built this path from the ENV ALONE and every one of them was correct until a
# real node held a non-production akash lane — then all six pointed at a file that is not
# there. The first one to execute (candidate-flight's reconcile-appset) failed the first
# poly mint with "missing at head_sha". Deriving it in one place is the fix; a CI invariant
# forbidding the env-only form is the guard.
#
# Usage:
#   CATALOG_DIR=infra/catalog . scripts/ci/lib/appset-paths.sh
#   control_env_for <env> <node>              # -> the env whose cluster reconciles it
#   appset_rel_path <env> <node>              # -> repo-relative ApplicationSet path
#   appsets_kustomization_rel_path <env> <node>
set -euo pipefail

: "${CATALOG_DIR:=infra/catalog}"
APPSETS_REL_DIR="infra/k8s/argocd/appsets"

# Which env's cluster reconciles (env, node)? Production for an akash node's non-production
# lane; the env itself otherwise. Absent `deployment_provider.<env>` means the k3s default,
# so an un-placed row is NEVER relocated — placement must be stated to move.
control_env_for() {
  local env="$1" node="$2" provider
  if [ "$env" = "production" ]; then printf 'production\n'; return 0; fi
  provider="$(yq -r ".deployment_provider.\"$env\" // \"\"" "$CATALOG_DIR/$node.yaml")"
  if [ "$provider" = "akash" ]; then printf 'production\n'; else printf '%s\n' "$env"; fi
}

# Repo-relative ApplicationSet path. Filename keeps the WORKLOAD env so one Argo namespace
# can hold a node's candidate-a, preview and production AppSets without colliding.
appset_rel_path() {
  printf '%s/%s/%s-%s-applicationset.yaml\n' "$APPSETS_REL_DIR" "$(control_env_for "$1" "$2")" "$1" "$2"
}

appsets_kustomization_rel_path() {
  printf '%s/%s/kustomization.yaml\n' "$APPSETS_REL_DIR" "$(control_env_for "$1" "$2")"
}
