#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
#
# verify-buildsha.sh — authoritative end-of-deploy gate: assert each node-app
# endpoint serves the SHA the flight claimed to deploy. Catches "green run,
# stale pods" — the pattern where an upstream step silently produced no new
# images (affected-only CI, build failure, wrong overlay), overlays stayed
# unchanged, Argo did nothing, all downstream gates reported green against
# the old pods.
#
# Two modes:
#   1. Single-SHA (preview, candidate): all promoted nodes built from the
#      same PR head SHA. Caller passes EXPECTED_BUILDSHA + NODES.
#   2. Per-app map (production, candidate-a cross-PR): different nodes built from
#      different PR head SHAs (affected-only CI rebuilt a subset; production
#      copies preview's mixed overlay state). Caller passes SOURCE_SHA_MAP
#      pointing to .promote-state/source-sha-by-app.json — the script asserts
#      /version.buildSha against map entries. Optional NODES (CSV): when set,
#      verify only that subset (task.0349; flights pass promoted_apps). When
#      unset, every Ingress-probeable key in the map is checked.
#
# Contract (both modes): `/version.buildSha` equals the expected SHA for this
# node. Any mismatch is a hard failure regardless of prior workflow status.
#
# Endpoint choice (task.0345 / PR #978): we probe the dedicated `/version`
# endpoint rather than `/readyz`. Rationale:
#   - `/version` is unauthenticated and dependency-free (no env, secrets, RPC,
#     or Temporal checks) — it cannot false-fail due to transient infra
#     degradation while the build artifact is correctly deployed.
#   - `/readyz` returns 503 on infra-degraded (by design); serving the right
#     buildSha is a distinct signal from "I am ready to serve traffic".
#   - Separation lets us retire the prior `/readyz.version` field without
#     breaking liveness/readiness semantics.
# Response shape: `{"version": "<pkg-ver>", "buildSha": "<git-sha>", "buildTime": "..."}`
# — we read `.buildSha` (the git SHA); `.version` on this endpoint is the
# package version, NOT a fallback.
#
# Env (single-SHA mode):
#   DOMAIN              (required) base domain (operator Ingress host)
#   EXPECTED_BUILDSHA   (required) PR head SHA — full 40-char hex
#   NODES               (required) CSV of node-app names to verify. MUST be
#                       the set that was actually promoted in this run — do
#                       not default to "operator,poly,resy" because affected-
#                       only CI rebuilds a subset and untouched nodes
#                       legitimately serve a different (prior) PR head SHA.
#                       Pass the empty string to skip (no-op promotion case).
#
# Env (map mode — takes precedence when set and non-empty):
#   DOMAIN              (required)
#   SOURCE_SHA_MAP      path to .promote-state/source-sha-by-app.json. Each
#                       key is an app name; each value is the PR head SHA
#                       that built that app's overlay digest. Unset or
#                       missing file → fall back to single-SHA mode.
#   NODES               (optional CSV) when set and non-empty in map mode:
#                       verify **only** these apps' map entries (intersection),
#                       not every key in the file. Required for affected-only
#                       flights/promotes: the map still carries older SHAs for
#                       apps not promoted this run (task.0349).
#
# Hostname convention: operator → https://$DOMAIN, others → https://$node-$DOMAIN.

set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN required}"
SOURCE_SHA_MAP="${SOURCE_SHA_MAP:-}"
# bug.5002 — DEPLOY_ENV selects which catalog public_url entry the verifier
# uses. Callers (candidate-flight.yml, promote-and-deploy.yml) export
# OVERLAY_ENV / DEPLOY_ENVIRONMENT; accept either, fall back to the legacy
# DOMAIN-derivation when neither is set (laptop CLI callers).
DEPLOY_ENV="${DEPLOY_ENV:-${OVERLAY_ENV:-${DEPLOY_ENVIRONMENT:-}}}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -f "${SCRIPT_DIR}/lib/image-tags.sh" ]; then
  # shellcheck source=lib/image-tags.sh
  . "${SCRIPT_DIR}/lib/image-tags.sh"
fi
# When set, write verified-<node>.txt = "true" for each node whose /version
# contract holds. The verify-deploy matrix uploads this dir as the
# cell-verify-<node> artifact; aggregate-decide-outcome.sh asserts every
# promoted cell has a matching marker (Axiom 19). Markers are also emitted
# for non-Ingress nodes (scheduler-worker, migrators) since rollout-status
# upstream is the verifying primitive there — without the markers, Axiom 19
# false-fails every production aggregate (bug.0443).
MARKER_DIR="${MARKER_DIR:-}"

# Cutover polling (task.0341): Argo "Healthy" fires before ingress endpoints
# fully cut over to new pods, so a one-shot probe can hit the old pod
# serving the prior SHA. Retry per-node until the expected SHA appears or
# CUTOVER_TIMEOUT expires. Default 90s covers normal pod-startup + endpoint
# propagation; anything longer is a real deploy issue, not a cutover race,
# and SHOULD fail loudly — do not inflate this number to mask pathologies.
CUTOVER_TIMEOUT="${CUTOVER_TIMEOUT:-90}"
CUTOVER_SLEEP="${CUTOVER_SLEEP:-5}"

# Only node-apps expose /version via HTTPS Ingress. scheduler-worker and
# migrator are promoted-apps too but are in-cluster only — they're covered
# by wait-for-in-cluster-services (kubectl rollout status) upstream.
NODE_APPS="operator poly resy"

declare -A EXPECTED_BY_NODE=()

# Prefer map mode when SOURCE_SHA_MAP is set AND the file exists. The
# defensive fallback (file missing on first deploy after Fix 4 lands) is
# the single-SHA path below.
if [ -n "$SOURCE_SHA_MAP" ] && [ -f "$SOURCE_SHA_MAP" ]; then
  echo "ℹ️  verify-buildsha: per-app map mode (SOURCE_SHA_MAP=${SOURCE_SHA_MAP})"
  while IFS=$'\t' read -r app sha; do
    [ -z "$app" ] && continue
    sha=$(printf '%s' "$sha" | tr '[:upper:]' '[:lower:]')
    EXPECTED_BY_NODE["$app"]="$sha"
  done < <(python3 - "$SOURCE_SHA_MAP" <<'PY'
import json, sys
with open(sys.argv[1], "r", encoding="utf-8") as handle:
    data = json.load(handle)
if not isinstance(data, dict):
    sys.exit(0)
for app, sha in sorted(data.items()):
    if isinstance(sha, str) and sha:
        print(f"{app}\t{sha}")
PY
)
  if [ "${#EXPECTED_BY_NODE[@]}" -eq 0 ]; then
    echo "ℹ️  source-sha-by-app.json has no entries — skipping buildSha check."
    exit 0
  fi

  # task.0349: map mode + non-empty NODES → verify only promoted apps.
  # Without this, every ingress node in the full map is probed; affected-only
  # flights promote a subset but the map still holds prior SHAs for other apps,
  # which produces false reds (e.g. poly-only flight still checking operator).
  if [ -n "${NODES:-}" ]; then
    declare -A FILTERED=()
    IFS=',' read -r -a WANT <<<"${NODES}"
    for raw in "${WANT[@]}"; do
      app=$(printf '%s' "$raw" | tr -d '[:space:]')
      [ -z "$app" ] && continue
      if [ -n "${EXPECTED_BY_NODE[$app]+x}" ]; then
        FILTERED["$app"]="${EXPECTED_BY_NODE[$app]}"
      else
        echo "::error::verify-buildsha: NODES includes '${app}' but SOURCE_SHA_MAP has no entry — map/promotion mismatch" >&2
        exit 1
      fi
    done
    if [ "${#FILTERED[@]}" -eq 0 ]; then
      echo "::error::verify-buildsha: NODES='${NODES}' produced no matching map entries" >&2
      exit 1
    fi
    EXPECTED_BY_NODE=()
    for k in "${!FILTERED[@]}"; do
      EXPECTED_BY_NODE["$k"]="${FILTERED[$k]}"
    done
    echo "ℹ️  verify-buildsha: map mode restricted to NODES=${NODES} (${#EXPECTED_BY_NODE[@]} app(s))"
  fi
else
  if [ -n "$SOURCE_SHA_MAP" ]; then
    echo "ℹ️  verify-buildsha: SOURCE_SHA_MAP=${SOURCE_SHA_MAP} set but file missing — falling back to single-SHA mode"
  fi
  # Single-SHA mode: require EXPECTED_BUILDSHA + NODES.
  EXPECTED_BUILDSHA="${EXPECTED_BUILDSHA:?EXPECTED_BUILDSHA required in single-SHA mode (or pass SOURCE_SHA_MAP)}"
  NODES="${NODES?NODES required (CSV of promoted nodes; pass \"\" to skip)}"

  if [ -z "$NODES" ]; then
    echo "ℹ️  NODES is empty — no apps promoted in this run, skipping buildSha check."
    exit 0
  fi

  EXPECTED_BUILDSHA=$(printf '%s' "$EXPECTED_BUILDSHA" | tr '[:upper:]' '[:lower:]')
  IFS=',' read -r -a NODE_ARR_RAW <<<"$NODES"
  for n in "${NODE_ARR_RAW[@]}"; do
    EXPECTED_BY_NODE["$n"]="$EXPECTED_BUILDSHA"
  done
fi

# Filter down to Ingress-probeable node-apps. Entries for scheduler-worker /
# migrator are upstream-covered (kubectl rollout status); skip them here.
NODE_ARR=()
NON_INGRESS_NODES=()
for app in "${!EXPECTED_BY_NODE[@]}"; do
  matched=0
  for p in $NODE_APPS; do
    if [ "$app" = "$p" ]; then
      NODE_ARR+=("$app")
      matched=1
      break
    fi
  done
  [ "$matched" = "0" ] && NON_INGRESS_NODES+=("$app")
done

if [ -n "$MARKER_DIR" ] && [ "${#NON_INGRESS_NODES[@]}" -gt 0 ]; then
  mkdir -p "$MARKER_DIR"
  for n in "${NON_INGRESS_NODES[@]}"; do
    printf 'true' > "${MARKER_DIR}/verified-${n}.txt"
    echo "  ✅ ${n}: non-Ingress (rollout-status verified upstream) — marker written"
  done
fi

if [ "${#NODE_ARR[@]}" -eq 0 ]; then
  echo "ℹ️  No Ingress-probeable apps to verify — skipping buildSha check."
  exit 0
fi

# Allow the test harness (or future callers) to inject a curl wrapper so we
# don't need a real HTTPS endpoint to cover the polling logic.
CURL_CMD="${CURL_CMD:-curl -sk --max-time 10}"

# Poll $url (/version) until .buildSha matches $expected or CUTOVER_TIMEOUT
# elapses. Returns 0 on match, 1 on timeout. Prints the final line outcome.
# Reads `.buildSha` from the response — `.version` on /version is the package
# version (e.g. "0.1.0"), not the git SHA, so it is not a valid fallback.
check_node() {
  local node="$1" expected="$2" url="$3"
  local deadline=$(( SECONDS + CUTOVER_TIMEOUT ))
  local attempts=0 actual="" body=""

  while :; do
    attempts=$((attempts + 1))
    body=$($CURL_CMD "$url" 2>/dev/null || echo "")
    actual=$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.loads(sys.stdin.read()).get("buildSha",""))' 2>/dev/null || echo "")
    actual=$(printf '%s' "$actual" | tr '[:upper:]' '[:lower:]')

    if [ "$actual" = "$expected" ] && [ -n "$actual" ]; then
      echo "  ✅ ${node}: buildSha=${actual:0:12} matches expected ${expected:0:12} (attempt ${attempts})"
      return 0
    fi

    if [ "$SECONDS" -ge "$deadline" ]; then
      if [ -z "$actual" ]; then
        echo "  ❌ ${node}: ${url} returned no parseable buildSha after ${CUTOVER_TIMEOUT}s / ${attempts} attempts (body: ${body:0:120})"
      else
        echo "  ❌ ${node}: buildSha=${actual:0:12} != expected ${expected:0:12} after ${CUTOVER_TIMEOUT}s / ${attempts} attempts"
      fi
      return 1
    fi

    sleep "$CUTOVER_SLEEP"
  done
}

FAILED=0

for node in "${NODE_ARR[@]}"; do
  expected="${EXPECTED_BY_NODE[$node]}"

  # bug.5002 — prefer catalog-declared public_url for $DEPLOY_ENV. Falls
  # back to the legacy URL builder when DEPLOY_ENV is unset (laptop CLI)
  # or when the catalog has no public_url entry for this env.
  url=""
  if [ -n "$DEPLOY_ENV" ] && declare -f public_url_for_target >/dev/null 2>&1; then
    catalog_url=$(public_url_for_target "$DEPLOY_ENV" "$node" 2>/dev/null || true)
    [ -n "$catalog_url" ] && url="${catalog_url}/version"
  fi
  if [ -z "$url" ]; then
    if [ "$node" = "operator" ]; then
      host="${DOMAIN}"
    elif [[ "$DOMAIN" == *.*.* ]]; then
      host="${node}-${DOMAIN}"
    else
      host="${node}.${DOMAIN}"
    fi
    url="https://${host}/version"
  fi

  if check_node "$node" "$expected" "$url"; then
    if [ -n "$MARKER_DIR" ]; then
      mkdir -p "$MARKER_DIR"
      printf 'true' > "${MARKER_DIR}/verified-${node}.txt"
    fi
  else
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo ""
  echo "❌ buildSha mismatch — deploy did not actually promote expected images."
  echo "   Common causes:"
  echo "     1. pr-build built no images (affected-only scope missed a node or CI-only PR)."
  echo "     2. promote-k8s found no new digest for an app (image not in GHCR)."
  echo "     3. Argo stuck on prior reconcile (check wait-for-argocd output)."
  echo "     4. Ingress still serving old pod (uncommon — verify with kubectl)."
  exit 1
fi

echo "✅ all node-apps serving expected buildSha"
