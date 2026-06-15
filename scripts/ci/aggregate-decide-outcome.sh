#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO

# Single decision function for aggregate-{preview,production} in
# promote-and-deploy.yml. Walks per-cell artifacts and the upstream job
# results, applies Axiom 19 (every promoted cell must have verified) and
# Axiom 14 (no advance when no cell promoted), emits outcome to
# $GITHUB_OUTPUT.
#
# Exit semantics:
#   no cell promoted=true  → exit 1 unconditionally. This is the silent-success
#                            seam an admin-merged PR slips through (bug.0443):
#                            promote-k8s legs write PROMOTED=false and every
#                            verify-deploy step-skips green. The aggregator
#                            must be the loud-fail backstop. The downstream
#                            "Unlock preview on failure" step is gated
#                            `if: always()` so the lease still releases.
#   E2E_RESULT skipped      → allowed only for preview. Preview can skip e2e
#                            while still being a valid per-node deploy when
#                            promote, verify, and verify-deploy all succeeded.
#                            Production remains strict and requires e2e success.
#   STRICT_FAIL set         → exit 1 if outcome != dispatched. Used by
#                            aggregate-production whose job-level `if:`
#                            already requires all upstream results success;
#                            preview routinely skips e2e so it can't gate
#                            on full-success without a separate change.
#
# Required env:
#   ENV                     preview | production
#   CELLS_DIR               merged dir containing promoted-*.txt + verified-*.txt
#   PROMOTE_RESULT          needs.promote-k8s.result
#   VERIFY_RESULT           needs.verify.result
#   VERIFY_DEPLOY_RESULT    needs.verify-deploy.result
#   E2E_RESULT              needs.e2e.result
#
# Optional env:
#   DEPLOY_INFRA_RESULT     preview only; treated as success when unset.
#                           Only failure | cancelled disqualify.
#   STRICT_FAIL             see Exit semantics above.
#   GITHUB_OUTPUT           when set, outcome= is appended.
#
# Links:
#   work/items/bug.0443.merge-queue-preview-promote-silent-skip.md

set -euo pipefail

: "${ENV:?ENV required}"
: "${CELLS_DIR:?CELLS_DIR required}"
: "${PROMOTE_RESULT:?PROMOTE_RESULT required}"
: "${VERIFY_RESULT:?VERIFY_RESULT required}"
: "${VERIFY_DEPLOY_RESULT:?VERIFY_DEPLOY_RESULT required}"
: "${E2E_RESULT:?E2E_RESULT required}"
DEPLOY_INFRA_RESULT="${DEPLOY_INFRA_RESULT:-success}"

any_promoted=false
unverified=()

if [ -d "$CELLS_DIR" ]; then
  shopt -s nullglob
  for f in "$CELLS_DIR"/promoted-*.txt; do
    node=$(basename "$f" .txt | sed 's/^promoted-//')
    if [ "$(cat "$f" 2>/dev/null || true)" = "true" ]; then
      any_promoted=true
      if [ "$(cat "$CELLS_DIR/verified-${node}.txt" 2>/dev/null || true)" != "true" ]; then
        unverified+=("$node")
      fi
    fi
  done
fi

outcome=failed
no_promotion=0
e2e_ok=false
if [ "$E2E_RESULT" = "success" ] || { [ "$ENV" = "preview" ] && [ "$E2E_RESULT" = "skipped" ]; }; then
  e2e_ok=true
fi

if [ "$any_promoted" != "true" ]; then
  echo "::error::aggregate-${ENV}: no cell reported promoted=true — refusing to advance"
  no_promotion=1
elif [ ${#unverified[@]} -gt 0 ]; then
  echo "::error::aggregate-${ENV}: cells promoted but did not verify — Axiom 19 contradiction: ${unverified[*]}"
elif [ "$PROMOTE_RESULT" = "success" ] \
  && [ "$VERIFY_RESULT" = "success" ] \
  && [ "$VERIFY_DEPLOY_RESULT" = "success" ] \
  && [ "$e2e_ok" = "true" ] \
  && [ "$DEPLOY_INFRA_RESULT" != "failure" ] \
  && [ "$DEPLOY_INFRA_RESULT" != "cancelled" ]; then
  outcome=dispatched
fi

echo "outcome=${outcome}"
echo "promote=${PROMOTE_RESULT} verify=${VERIFY_RESULT} verify-deploy=${VERIFY_DEPLOY_RESULT} e2e=${E2E_RESULT} deploy-infra=${DEPLOY_INFRA_RESULT}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "outcome=${outcome}" >> "$GITHUB_OUTPUT"
fi

if [ "$no_promotion" = "1" ]; then
  exit 1
fi

if [ -n "${STRICT_FAIL:-}" ] && [ "$outcome" != "dispatched" ]; then
  exit 1
fi
