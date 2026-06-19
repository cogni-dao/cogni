#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# Script: scripts/setup/register-substrate-apps.sh
# Purpose: Idempotently activate the three substrate Argo CD Applications
#          (openbao, external-secrets, reloader) on an ALREADY-RUNNING cluster
#          whose deploy/<env> branch + Argo predate one of those apps existing
#          in-repo. Backfills WITHOUT a destructive full re-provision.
#
#          Activation has two halves, both of which this script performs:
#
#            1. SEED — copy each substrate's kustomize dir + its Application
#               manifest from this checkout onto the fork's deploy/<env>
#               branch. The promote-and-deploy pipeline only rsyncs
#               infra/k8s/base + overlays to deploy/<env> — it does NOT sync
#               infra/k8s/argocd/, so a substrate added after the env was last
#               provisioned never lands on its deploy branch (provision-env-vm
#               Phase 4b.5 refuses to update a diverged deploy branch). Without
#               the manifests on deploy/<env>, the Argo Application's
#               `path: infra/k8s/argocd/<app>` resolves to nothing and the app
#               never syncs.
#            2. REGISTER — render ${FORK_REPO}/${DEPLOY_BRANCH} and kubectl
#               apply the Application CRs into the cluster's argocd namespace,
#               exactly as provision-env-vm.sh Phase 5b.1 does on a fresh
#               provision.
#
#          Concretely: prod was provisioned before the `reloader` Application
#          existed (PR #1478, 2026-06-03). Its deploy/production branch lacks
#          infra/k8s/argocd/reloader/ and its Argo never received the reloader
#          CR, so the `reloader.stakater.com/auto: "true"` annotation on prod
#          Deployments is a silent no-op and ESO-backed secret rotations never
#          roll prod pods (bug.5040). This script closes both gaps idempotently.
#
# Usage:
#   GITHUB_ADMIN_PAT=<pat> KUBECONFIG=.local/production-kubeconfig.yaml \
#     bash scripts/setup/register-substrate-apps.sh production
#   GITHUB_ADMIN_PAT=<pat> KUBECONFIG=.local/candidate-a-kubeconfig.yaml \
#     bash scripts/setup/register-substrate-apps.sh candidate-a
#
#   A PAT with push to the fork's deploy/<env> branch is required for the SEED
#   half (push). Skip seeding (register-only) with SKIP_SEED=1 when the deploy
#   branch already carries the manifests.
#
# Environments: preview, production, candidate-* (matches provision-env-vm.sh).
#   DEPLOY_BRANCH = deploy/<env>.
#
# Safe to re-run. The seed is content-aware (only commits when the deploy
# branch is missing/stale a manifest); kubectl apply is idempotent; the
# reloader Application sets prune:false so an existing Reloader is never
# cascade-deleted.

set -euo pipefail

# Substrate Argo Applications, in dependency order. SSoT mirrors the
# provision-env-vm.sh Phase 5b.1 loop — keep the two lists in sync.
SUBSTRATE_APPS=(openbao external-secrets reloader)

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'
log_info()  { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1" >&2; }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

DEPLOY_ENV="${1:-}"
case "$DEPLOY_ENV" in
  preview|production|candidate-*) ;;
  *)
    log_error "Usage: KUBECONFIG=<path> [GITHUB_ADMIN_PAT=<pat>] $0 <preview|production|candidate-*>"
    exit 2
    ;;
esac
DEPLOY_BRANCH="deploy/${DEPLOY_ENV}"
SKIP_SEED="${SKIP_SEED:-0}"

# Derive the fork repo the same way provision-env-vm.sh does, so the rendered
# Application repoURL matches the live cluster's other substrate apps.
GH_REPO=$(git -C "$REPO_ROOT" remote get-url origin \
  | sed -E 's#.*github.com[:/]([^/]+/[^/.]+).*#\1#')
if [[ -z "$GH_REPO" ]]; then
  log_error "Could not derive GH_REPO from origin remote."
  exit 1
fi
FORK_REPO="https://github.com/${GH_REPO}.git"

# ── Half 1: SEED substrate manifests onto deploy/<env> ────────────────────
if [[ "$SKIP_SEED" == "1" ]]; then
  log_warn "SKIP_SEED=1 — assuming deploy/${DEPLOY_ENV} already carries the substrate manifests."
else
  PAT="${GITHUB_ADMIN_PAT:-${GHCR_TOKEN:-}}"
  if [[ -z "$PAT" ]]; then
    log_error "No GITHUB_ADMIN_PAT/GHCR_TOKEN in env — needed to push the substrate"
    log_error "manifests to ${DEPLOY_BRANCH}. Set one, or pass SKIP_SEED=1 if the"
    log_error "deploy branch already has infra/k8s/argocd/{openbao,external-secrets,reloader}/."
    exit 1
  fi
  PUSH_URL="https://x-access-token:${PAT}@github.com/${GH_REPO}.git"
  SEED_TMP="$(mktemp -d)"
  trap 'rm -rf "$SEED_TMP"' EXIT
  log_info "Seeding substrate manifests onto ${DEPLOY_BRANCH} (content-aware)..."
  git clone --depth=1 --branch "$DEPLOY_BRANCH" "https://github.com/${GH_REPO}.git" "$SEED_TMP" >/dev/null 2>&1 \
    || { log_error "Could not clone ${DEPLOY_BRANCH} from ${GH_REPO}."; exit 1; }
  for substrate in "${SUBSTRATE_APPS[@]}"; do
    # The kustomize dir + its Application manifest are the env-agnostic source.
    rsync -a --delete \
      "$REPO_ROOT/infra/k8s/argocd/${substrate}/" \
      "$SEED_TMP/infra/k8s/argocd/${substrate}/"
    cp "$REPO_ROOT/infra/k8s/argocd/${substrate}-application.yaml" \
       "$SEED_TMP/infra/k8s/argocd/${substrate}-application.yaml"
  done
  if ! git -C "$SEED_TMP" diff --quiet || \
     [[ -n "$(git -C "$SEED_TMP" status --porcelain)" ]]; then
    git -C "$SEED_TMP" add infra/k8s/argocd/
    git -C "$SEED_TMP" -c user.name='cogni-bot' -c user.email='bot@cognidao.org' \
      commit -q -m "infra(${DEPLOY_ENV}): seed substrate Argo manifests (bug.5040)"
    git -C "$SEED_TMP" push "$PUSH_URL" "HEAD:${DEPLOY_BRANCH}" >/dev/null 2>&1 \
      || { log_error "Push to ${DEPLOY_BRANCH} failed (check PAT push permission)."; exit 1; }
    log_info "Pushed substrate manifests to ${DEPLOY_BRANCH}."
  else
    log_info "${DEPLOY_BRANCH} already carries current substrate manifests — nothing to seed."
  fi
fi

# ── Half 2: REGISTER the Application CRs into the cluster ──────────────────
if ! kubectl get ns argocd >/dev/null 2>&1; then
  log_error "argocd namespace not found on current kubeconfig context."
  log_error "Point KUBECONFIG at the target cluster (e.g. .local/${DEPLOY_ENV}-kubeconfig.yaml)."
  exit 1
fi

CTX="$(kubectl config current-context 2>/dev/null || echo unknown)"
log_info "Registering substrate Argo Applications on context=${CTX}"
log_info "  repo=${FORK_REPO} branch=${DEPLOY_BRANCH}"

for substrate in "${SUBSTRATE_APPS[@]}"; do
  src="$REPO_ROOT/infra/k8s/argocd/${substrate}-application.yaml"
  if [[ ! -f "$src" ]]; then
    log_error "Missing Application manifest: $src"
    exit 1
  fi
  rendered=$(mktemp)
  sed -e "s#\${FORK_REPO}#${FORK_REPO}#g" \
      -e "s#\${DEPLOY_BRANCH}#${DEPLOY_BRANCH}#g" \
      "$src" >"$rendered"
  kubectl apply -n argocd -f "$rendered"
  rm -f "$rendered"
  log_info "Applied Argo Application: ${substrate}"
done

echo
log_info "Done. Argo will sync each Application from ${DEPLOY_BRANCH}."
log_info "Verify Reloader: kubectl -n reloader get deploy,pods"
log_info "Verify app:      kubectl -n argocd get application reloader"
