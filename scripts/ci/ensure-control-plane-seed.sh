#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Module: scripts/ci/ensure-control-plane-seed.sh
# Purpose: Idempotently ensure the per-env Argo `root app-of-apps` seed
#          (cogni-<env>-control-plane) exists on a live cluster, applied from
#          the promote pipeline. New envs get the seed at provision
#          (bootstrap-k3s.yaml / provision-env-vm.sh); ALREADY-provisioned
#          preview/production won't re-provision, so #1913's root app-of-apps
#          only reaches them via GitOps if the promote pipeline applies it.
#          This closes that gap without a manual SSH kubectl apply.
# Scope: applies ONLY the one tiny root Application manifest (the apply-once
#          seed). It NEVER touches the app-of-apps below it — Argo owns that
#          once the seed exists (prune+selfHeal). Sibling of reconcile-appset /
#          reconcile-node-dns: a substrate-reconcile step in the promote lane.
# Invariants:
#   - IDEMPOTENT: `kubectl apply -f <seed>` is a no-op when the root Application
#     already matches; adoption of an existing app-of-apps is proven safe.
#   - NON-FATAL for envs without a seed: candidate-b / pre-seed envs ship no
#     roots/<env>-control-plane-application.yaml → warn + exit 0, never fail.
#   - SINGLE run per env (no per-node fan-out): the seed is env-scoped.
#
# Env:
#   DEPLOY_ENVIRONMENT — required, e.g. "preview", "production".
#   VM_HOST            — required, the target VM host (root@$VM_HOST).
#   SSH_OPTS           — required, the `ssh -i ... -o ...` options string
#                        (mirrors promote-and-deploy.yml's reconcile-appset step).
set -euo pipefail

ENV="${DEPLOY_ENVIRONMENT:?DEPLOY_ENVIRONMENT is required (e.g. preview, production)}"
VM_HOST="${VM_HOST:?VM_HOST is required}"
SSH_OPTS="${SSH_OPTS:?SSH_OPTS is required (ssh -i ... options, as in reconcile-appset)}"

SEED="infra/k8s/argocd/control-plane/roots/${ENV}-control-plane-application.yaml"

if [ ! -f "$SEED" ]; then
  echo "::warning::no control-plane seed for ${ENV}, skipping"
  exit 0
fi

SEED_BASENAME="$(basename "$SEED")"

# shellcheck disable=SC2086
scp $SSH_OPTS "$SEED" root@"$VM_HOST":/tmp/"$SEED_BASENAME"
# shellcheck disable=SC2086
ssh $SSH_OPTS root@"$VM_HOST" "kubectl apply -f /tmp/${SEED_BASENAME} -n argocd && rm -f /tmp/${SEED_BASENAME}"

echo "✅ Ensured control-plane seed: cogni-${ENV}-control-plane (idempotent apply)"
