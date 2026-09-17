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

# The INVERSE of control_env_for, for ONE node: every OTHER env of <node> whose lane this
# control env owns. Catalog-derived from the node's own `envs:` list — never a node list and
# never a hardcoded lane, so a lane added by a catalog edit is picked up with no code change.
#
# WHY THIS EXISTS (bug.5206): the directory question and the vault question have the SAME
# answer. `akash-actuator-wallet-cutover` states it as mechanism, not preference — "whoever
# renders the lease must be able to read that lane's secrets, because every workload env value
# reaches Akash as a placeholder resolved in the RECONCILING cluster. So the paying cluster
# holds every environment's workload secrets." Custody flows DOWN-TRUST only; the reverse —
# handing a candidate-a flight the production vault — is explicitly rejected there.
# THE SUFFIX A FOREIGN-CUSTODIED LANE'S SHARED-NAMESPACE IDENTIFIERS CARRY (bug.5207).
#
# A database and its roles were named from the NODE alone. The env was never IN the name —
# it was implicit in the HOST, because one env meant one VM meant one Postgres. A lane the
# PAYING cluster custodies lands on that cluster's Postgres alongside production's own row,
# where `cogni_<node>` and `app_<node>` are the SAME objects. A lane reconcile would then
# reconcile the LIVE production role's password to the lane's value.
#
# Callers pass the control env they already resolved, so this stays a pure formatting rule
# with one definition. Empty for every row that exists today (control == lane), so nothing
# migrates; a foreign-custodied lane is new by construction and is born correct.
lane_db_suffix() {
  local lane="$1" control="$2"
  [ -n "$lane" ] && [ "$control" != "$lane" ] || return 0
  printf '_%s' "${lane//-/_}"
}

lanes_reconciled_by() {
  local want="$1" node="$2" env
  for env in $(yq -r '.envs[]?' "$CATALOG_DIR/$node.yaml"); do
    [ "$env" = "$want" ] && continue
    [ "$(control_env_for "$env" "$node")" = "$want" ] || continue
    printf '%s\n' "$env"
  done
}
