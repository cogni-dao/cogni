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

echo "[run-node-substrate] ${DEPLOY_ENVIRONMENT}/${TARGET_NODE} (${DEPLOYMENT_PROVIDER}): materialize → reconcile → provider assert"

bash "$MATERIALIZE_BIN" "$DEPLOY_ENVIRONMENT" "$TARGET_NODE"
DEPLOYMENT_PROVIDER="$DEPLOYMENT_PROVIDER" \
  bash "$RECONCILE_BIN" "$DEPLOY_ENVIRONMENT" "$TARGET_NODE"
if [ "$DEPLOYMENT_PROVIDER" = "akash" ]; then
  TARGET="$TARGET_NODE" DEPLOYMENT_PROVIDER="$DEPLOYMENT_PROVIDER" \
    bash "$ASSERT_BIN" "$DEPLOY_ENVIRONMENT" "$TARGET_NODE"
fi

echo "[run-node-substrate] ${DEPLOY_ENVIRONMENT}/${TARGET_NODE}: provider preflight ready"
