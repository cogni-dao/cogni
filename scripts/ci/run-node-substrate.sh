#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# run-node-substrate.sh <env> <node> — the ONE per-node substrate runner.
#
# Materialize node-owned OpenBao secrets, then reconcile placement-neutral substrate
# for a SINGLE node in a SINGLE env. The reconciler provisions DB roles/databases,
# ExternalSecrets, and shared runtime inventory for every node; it branches only its
# placement-specific work (for example, k3s Caddy/NodePort edge mutation). External
# compute then performs the read-only Akash prerequisite assertion. This is
# the foundation for uniform substrate behavior across the whole node lifecycle:
# candidate-a flight, preview promote, production promote all call this identically
# — there is no "node-formation" special-case. Whoever the deployable set is, each node
# in it gets its substrate run the same way, everywhere.
#
# Ordering is load-bearing: materialize (the sole OpenBao writer) MUST complete
# before reconcile (read-only db-reader) reads the per-node creds it composed —
# reconcile fails loud if they are absent (Invariant 16). A materialize failure
# aborts before reconcile (set -e), so a half-provisioned node never deploys.
#
# Preconditions (caller owns these GitHub-action concerns): ci-src (this repo) +
# app-src checked out, the node submodule initialized when present, and SSH to the
# VM set up (deploy_key on disk, known_hosts seeded).
#
# Env in: VM_HOST, SSH_OPTS, DOMAIN, APP_SOURCE_DIR, and
#   COGNI_CATALOG_ROOT, HEAD_SHA, NODE_SOURCE_SHA, STATUS_URL,
#   SUBSTRATE_RECONCILE_SUMMARY_FILE — passed through to the two scripts unchanged.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

DEPLOY_ENVIRONMENT="${1:?usage: run-node-substrate.sh <env> <node>}"
TARGET_NODE="${2:?usage: run-node-substrate.sh <env> <node>}"

# Script paths overridable for tests (mirrors the *_SSH_BIN seam in the callees).
MATERIALIZE_BIN="${RUN_NODE_SUBSTRATE_MATERIALIZE_BIN:-$SCRIPT_DIR/secret-materialize.sh}"
RECONCILE_BIN="${RUN_NODE_SUBSTRATE_RECONCILE_BIN:-$SCRIPT_DIR/reconcile-node-substrate.sh}"
ASSERT_BIN="${RUN_NODE_SUBSTRATE_ASSERT_BIN:-$SCRIPT_DIR/assert-target-substrate.sh}"
DEPLOYMENT_PROVIDER="${DEPLOYMENT_PROVIDER:-k3s}"

case "$DEPLOYMENT_PROVIDER" in
  k3s|akash) ;;
  *) echo "::error::run-node-substrate: unsupported DEPLOYMENT_PROVIDER '$DEPLOYMENT_PROVIDER'" >&2; exit 1 ;;
esac

# Normalize COGNI_CATALOG_ROOT to an ABSOLUTE path so both callees resolve the
# catalog identically regardless of cwd. They disagree on relative paths:
# secret-materialize sources image-tags.sh which globs the path verbatim (cwd-
# relative), while reconcile anchors a relative path to APP_SOURCE_DIR. Folding
# them behind one runner means one env value feeds both, so the runner makes it
# unambiguous here (anchoring a relative value to APP_SOURCE_DIR when needed).
if [ -n "${COGNI_CATALOG_ROOT:-}" ]; then
  case "$COGNI_CATALOG_ROOT" in
    /*) ;;
    *)
      if [ -d "$COGNI_CATALOG_ROOT" ]; then
        COGNI_CATALOG_ROOT="$(cd "$COGNI_CATALOG_ROOT" && pwd)"
      elif [ -n "${APP_SOURCE_DIR:-}" ] && [ -d "${APP_SOURCE_DIR}/${COGNI_CATALOG_ROOT}" ]; then
        COGNI_CATALOG_ROOT="$(cd "${APP_SOURCE_DIR}/${COGNI_CATALOG_ROOT}" && pwd)"
      fi
      ;;
  esac
  export COGNI_CATALOG_ROOT
fi

# THE TWO QUESTIONS THIS SCRIPT USED TO CONFLATE (bug.5206).
#
#   WHICH SUBSTRATE THE WORKLOAD DIALS -> this env's VM. The XR states it itself
#     (`runtime.substrateHost: cogni-<env>.vm...`), so DB roles, databases and shared
#     inventory are provisioned HERE, for every lane, always.
#   WHICH VAULT HOLDS THE LANE'S SECRETS -> the vault of the cluster that RECONCILES the
#     lane. Every workload env value reaches Akash as a placeholder resolved in the
#     reconciling cluster, so the paying cluster holds every environment's workload secrets
#     (`akash-actuator-wallet-cutover`: "a mechanism fact, not a preference").
#
# For a k3s row the two answers are the same env and nothing below changes. For an akash
# node's non-production lane they differ, and conflating them is what broke the first poly
# mint: the candidate-a flight wrote 32 keys into the CANDIDATE-A vault, asserted the bank
# complete against it, and reported "provider preflight ready" — while the ExternalSecret
# that actually feeds the lease reads the PRODUCTION vault and reported MissingProviderSecret
# for all seven keys. A green gate resting on an unchecked assumption.
#
# Custody flows DOWN-TRUST, one direction only. This script never reaches UP: a candidate-a
# flight does not hold production's vault and must not — that inversion is explicitly
# rejected. It declines the write it cannot legitimately make, and says where the write
# belongs, instead of performing a local one that looks like success.
CATALOG_DIR="${COGNI_CATALOG_ROOT:-${APP_SOURCE_DIR:-.}/infra/catalog}"
export CATALOG_DIR
# The catalog is what ANSWERS "which vault", so its absence is not a default — it is a
# question we cannot answer. `control_env_for` reads an absent file as "no placement stated"
# and hands back the env itself, which is the RIGHT reading for an un-placed row but the
# WRONG one for a row whose file simply is not here: it would silently restore the exact
# fail-open bug.5206 was. Fail loud instead; every caller already passes COGNI_CATALOG_ROOT.
[ -f "$CATALOG_DIR/$TARGET_NODE.yaml" ] || {
  echo "::error::run-node-substrate: no catalog row at $CATALOG_DIR/$TARGET_NODE.yaml — cannot resolve which cluster reconciles ${DEPLOY_ENVIRONMENT}/${TARGET_NODE}, and therefore which vault owns its secrets (bug.5206). Pass COGNI_CATALOG_ROOT." >&2
  exit 1
}
# shellcheck source=scripts/ci/lib/appset-paths.sh
. "$SCRIPT_DIR/lib/appset-paths.sh"
CONTROL_ENV="$(control_env_for "$DEPLOY_ENVIRONMENT" "$TARGET_NODE")"

# The bare zone every lane's public host hangs off (`cognidao.org`), used only to build
# ANOTHER lane's domain when this env custodies it. Derived by stripping this env's own
# label, so a fork on its own zone works with no extra configuration.
DOMAIN_ROOT="${DOMAIN:-}"
case "$DEPLOY_ENVIRONMENT" in
  preview)     DOMAIN_ROOT="${DOMAIN_ROOT#preview.}" ;;
  candidate-a) DOMAIN_ROOT="${DOMAIN_ROOT#test.}" ;;
esac

echo "[run-node-substrate] ${DEPLOY_ENVIRONMENT}/${TARGET_NODE} (${DEPLOYMENT_PROVIDER}): materialize → reconcile → provider assert"

if [ "$CONTROL_ENV" = "$DEPLOY_ENVIRONMENT" ]; then
  bash "$MATERIALIZE_BIN" "$DEPLOY_ENVIRONMENT" "$TARGET_NODE"
  # Then every OTHER lane of this node that THIS cluster reconciles. Catalog-derived, so a
  # lane added by a catalog edit is materialized with no code change, and a node with no
  # such lane (every k3s row, every production-only node) enumerates nothing.
  while read -r lane; do
    [ -n "$lane" ] || continue
    # DOMAIN builds the derive-env FQDN keys (APP_BASE_URL, NEXTAUTH_URL). It arrives scoped
    # to THIS env, so materializing another lane with it would silently stamp
    # `poly.cognidao.org` into the candidate-a bank — a wrong value written confidently,
    # which is the failure mode this whole item exists to kill. The lane's domain is a pure
    # label and derives from the same root; an unmappable lane FAILS rather than guesses.
    lane_domain=""
    case "$lane" in
      production)  lane_domain="$DOMAIN_ROOT" ;;
      preview)     lane_domain="preview.$DOMAIN_ROOT" ;;
      candidate-a) lane_domain="test.$DOMAIN_ROOT" ;;
    esac
    [ -n "$lane_domain" ] || {
      echo "::error::run-node-substrate: no public domain mapping for lane '$lane' — refusing to materialize its bank with ${DEPLOY_ENVIRONMENT}'s DOMAIN, which would stamp wrong FQDNs (bug.5206)" >&2
      exit 1
    }
    echo "[run-node-substrate] ${DEPLOY_ENVIRONMENT} reconciles ${lane}/${TARGET_NODE} — materializing that lane's secrets into THIS vault (bug.5206), domain ${lane_domain}"
    SECRETS_CONTROL_ENV="$DEPLOY_ENVIRONMENT" DOMAIN="$lane_domain" \
      bash "$MATERIALIZE_BIN" "$lane" "$TARGET_NODE"
  done <<EOF
$(lanes_reconciled_by "$DEPLOY_ENVIRONMENT" "$TARGET_NODE")
EOF
else
  echo "::notice::${TARGET_NODE}'s ${DEPLOY_ENVIRONMENT} lane is reconciled by '${CONTROL_ENV}' — its secrets live in that cluster's vault and are written by ${CONTROL_ENV}'s own substrate run. Skipping the materialize + secret-bank assert here; this lane's DB substrate is still provisioned below."
fi

DEPLOYMENT_PROVIDER="$DEPLOYMENT_PROVIDER" \
  bash "$RECONCILE_BIN" "$DEPLOY_ENVIRONMENT" "$TARGET_NODE"
if [ "$DEPLOYMENT_PROVIDER" = "akash" ] && [ "$CONTROL_ENV" = "$DEPLOY_ENVIRONMENT" ]; then
  TARGET="$TARGET_NODE" DEPLOYMENT_PROVIDER="$DEPLOYMENT_PROVIDER" \
    bash "$ASSERT_BIN" "$DEPLOY_ENVIRONMENT" "$TARGET_NODE"
fi

echo "[run-node-substrate] ${DEPLOY_ENVIRONMENT}/${TARGET_NODE}: provider preflight ready"
