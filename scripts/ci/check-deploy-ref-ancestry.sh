#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# scripts/ci/check-deploy-ref-ancestry.sh — bug.5150.
#
# DEPLOY_REF_SOURCE_IS_REACHABLE_FROM_MAIN. Every GitOps ref Argo tracks resolves to a
# monorepo SOURCE commit. That commit must still be reachable from `main`. When it is not,
# Argo keeps serving a tree nobody can see in main — and because the ref was content-identical
# at the moment it was set, the divergence is INVISIBLE until the next merge touches that path.
# Argo reports `OutOfSync` + `Healthy`, which reads as cosmetic. It is not.
#
# The incident this encodes: deploy/candidate-a-control-plane sat on 14c8b8d271, a commit that
# stopped being an ancestor of main when its PR squash-merged. Argo went on serving the STALE
# XComputeWorkload Composition — the one without the `identity` block — so every Crossplane
# CREATE came back `400 invalid_request: request failed schema validation` from an actuator that
# requires NOT-NULL identity. Two agents independently saw that ref `OutOfSync` and wrote it off.
# Both were right when they looked and wrong within the hour. ~3h of blind diagnosis.
#
# ── What "the deploy ref's SHA" means (why this is not one merge-base call) ──────────────────
# A deploy ref's TIP is never on main, by construction, in either shape the fleet uses:
#
#   SOURCE-SELECTION refs (deploy/<env>-control-plane). The operator writes a synthetic commit
#     whose TREE is the selected monorepo commit's tree and whose body carries
#     `Reviewed-Source: <sha40>` (github-repo-write.ts updateCandidateControlPlaneRef). The tip
#     is a new object every time; the SELECTION is the thing with an opinion about main.
#
#   RENDERED-ARTIFACT refs (deploy/<env>-<node>). The promote lane commits rendered overlays
#     with pinned digests on top of the previous deploy tip — content that is deliberately NOT
#     on main. Provenance is `.promote-state/source-sha-by-app.json`, keyed by app.
#
# So a raw `git merge-base --is-ancestor <tip> origin/main` is FALSE for all 52 deploy refs in
# this repo and carries zero signal. This check resolves each ref's monorepo source commit
# first, then asserts ancestry on THAT.
#
# ── The edge cases, and the call made on each ────────────────────────────────────────────────
# AHEAD (source is a strict descendant of origin/main) — a flight in progress. NOT a violation
#   for a source-selection ref: candidate-a exists to run a REVIEWED-but-UNMERGED control-plane
#   shape (see the targetRevision rationale in the root Application), and a descendant of the
#   current main tip is main + a reviewable delta — nothing is orphaned and nothing can rot
#   silently, because the moment main moves past it the state becomes DIVERGED and this check
#   goes red. It is reported loudly as `pass (flight in progress)`, never silently.
#   For a PROMOTED app ref (preview/production) AHEAD *is* a violation: those envs promote
#   merged SHAs, and an unmerged commit serving production is the red line.
#
# DIVERGED (neither ancestor nor descendant) — bug.5150 exactly. Always a violation where this
#   check has jurisdiction. This is the state 14c8b8d271 was in.
#
# UNREACHABLE (the source object does not exist on the remote at all) — strictly worse than
#   DIVERGED: no server ref reaches it, so it cannot be reviewed or re-derived. Violation.
#
# ── Jurisdiction (what is asserted vs. reported) ─────────────────────────────────────────────
# Reported-not-asserted rows are PRINTED WITH THEIR REASON on every run. Nothing is silently
# dropped — silent skipping is how this class of defect survives.
#
#   source-selection  ASSERTED  ON_MAIN | AHEAD pass; DIVERGED | UNREACHABLE fail.
#   promoted-app      ASSERTED  preview/production, monorepo-built node. ON_MAIN only.
#   flight-slot       reported  deploy/candidate-a-<node>. The single pre-merge validation slot
#                               holds whatever PR head was last flighted; being off main is its
#                               PURPOSE, so ancestry there carries no information.
#   foreign-source    reported  remote-source node (catalog `source_repo` ≠ this repo). The
#                               provenance SHA belongs to that node's own repo; this repo's main
#                               has no jurisdiction over it.
#   no-provenance     reported  ref carries neither a Reviewed-Source trailer nor a promote-state
#                               entry for its own app (type:infra seed branches).
#   absent            reported  ref does not exist on the remote yet — a node born but never
#                               flighted. MUST NOT fail the build.
#
# ── Cost ─────────────────────────────────────────────────────────────────────────────────────
# One `git ls-remote --heads` (no objects) resolves existence + tip SHAs and lets a
# not-yet-created ref be skipped instead of aborting the whole fetch. One `--depth=1` fetch
# brings every tracked tip's commit + tree (provenance lives in the tip). Provenance commits
# are fetched individually and ONLY for asserted rows that are not already present via main —
# the pass path costs no extra round trip at all.
#
# Usage:
#   bash scripts/ci/check-deploy-ref-ancestry.sh
# Env:
#   COGNI_CATALOG_ROOT              catalog dir (default infra/catalog; honoured by image-tags.sh)
#   COGNI_ARGOCD_ROOT               Argo manifest dir scanned for tracked refs
#                                     (default <catalog>/../k8s/argocd)
#   DEPLOY_REF_CHECK_REMOTE         git remote to read (default origin)
#   DEPLOY_REF_CHECK_MAIN_REF       the authority ref (default origin/main)
#   DEPLOY_REF_CHECK_SKIP_FETCH=1   assume refs are already local (tests / offline)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# shellcheck source=scripts/ci/lib/image-tags.sh
source "$SCRIPT_DIR/lib/image-tags.sh"

CATALOG_ROOT="${COGNI_CATALOG_ROOT:-${REPO_ROOT}/infra/catalog}"
ARGOCD_ROOT="${COGNI_ARGOCD_ROOT:-$(cd "${CATALOG_ROOT}/.." && pwd)/k8s/argocd}"
REMOTE="${DEPLOY_REF_CHECK_REMOTE:-origin}"
MAIN_REF="${DEPLOY_REF_CHECK_MAIN_REF:-origin/main}"
LOCAL_NS="refs/cogni/deploy-ref-check"

for tool in git jq yq; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "[ERROR] check-deploy-ref-ancestry: '$tool' is required" >&2
    exit 1
  }
done

git rev-parse --verify --quiet "${MAIN_REF}^{commit}" >/dev/null || {
  echo "[ERROR] check-deploy-ref-ancestry: '${MAIN_REF}' is not resolvable." >&2
  echo "        CI must check out with fetch-depth: 0 so main's full history is local —" >&2
  echo "        a shallow main makes every ancestry answer a lie." >&2
  exit 1
}
MAIN_SHA="$(git rev-parse "$MAIN_REF")"

# ── Enumeration ──────────────────────────────────────────────────────────────
# REF_ORDER preserves a stable report order; REF_NODE / REF_ENV / REF_KIND carry the
# per-ref facts the policy needs. A ref discovered in BOTH planes keeps its catalog
# identity (the catalog knows which app the promote-state entry is keyed by).
declare -a REF_ORDER=()
declare -A REF_NODE=()
declare -A REF_ENV=()
declare -A REF_KIND=()

record_ref() {
  local ref="$1" node="$2" env="$3" kind="$4"
  if [ -n "${REF_KIND[$ref]+x}" ]; then return 0; fi
  REF_ORDER+=("$ref")
  REF_NODE["$ref"]="$node"
  REF_ENV["$ref"]="$env"
  REF_KIND["$ref"]="$kind"
}

# Plane 1 — the catalog rows (CATALOG_IS_SSOT). One cell per (target, env).
for target in "${ALL_TARGETS[@]}"; do
  for env in "${DEPLOY_BRANCH_ENVS[@]}"; do
    branch="$(deploy_branch_for_target "$target" "$env")"
    [ -n "$branch" ] || continue
    record_ref "$branch" "$target" "$env" "app"
  done
done

# Longest-match the env out of a ref name against the envs the catalog declares, so
# `deploy/candidate-a-control-plane` yields `candidate-a` and not `candidate` — the env is a
# routing fact that ends up in the operator call the failure message prints.
env_for_ref() {
  local ref="$1" candidate
  for candidate in "${DEPLOY_BRANCH_ENVS[@]}"; do
    case "$ref" in
      "deploy/${candidate}" | "deploy/${candidate}-"*)
        printf '%s' "$candidate"
        return 0
        ;;
    esac
  done
  printf ''
}

# Plane 2 — refs Argo tracks that no catalog row declares (the control-plane class, which is
# exactly where bug.5150 lived). Scans `targetRevision:` AND the ApplicationSet generators'
# `revision:`; a templated value ({{.name}}) is a family, not a ref, and is resolved by plane 1.
if [ -d "$ARGOCD_ROOT" ]; then
  while IFS= read -r branch; do
    [ -n "$branch" ] || continue
    case "$branch" in *'{{'*) continue ;; esac
    record_ref "$branch" "" "$(env_for_ref "$branch")" "control-plane"
  done < <(
    grep -rhoE '^[[:space:]]*(targetRevision|revision):[[:space:]]*"?deploy/[^"[:space:]]+"?[[:space:]]*$' \
      "$ARGOCD_ROOT" 2>/dev/null |
      sed -E 's/^[[:space:]]*(targetRevision|revision):[[:space:]]*"?//; s/"?[[:space:]]*$//' |
      sort -u
  )
fi

if [ "${#REF_ORDER[@]}" -eq 0 ]; then
  echo "[ERROR] check-deploy-ref-ancestry: enumerated zero deploy refs." >&2
  echo "        Catalog root: ${CATALOG_ROOT}" >&2
  echo "        Argo root:    ${ARGOCD_ROOT}" >&2
  echo "        Enumerating nothing would make this check vacuously green — failing closed." >&2
  exit 1
fi

# ── Remote state: one ls-remote, no objects ──────────────────────────────────
# Asking for the enumerated refs BY NAME keeps the answer exact and small, and — unlike a
# fetch — a name that does not exist yet is simply absent from the reply instead of aborting
# the whole call, which is what makes the new-node case free.
ls_patterns=()
for ref in "${REF_ORDER[@]}"; do ls_patterns+=("refs/heads/${ref}"); done

if ! ls_remote_out="$(git ls-remote --heads "$REMOTE" "${ls_patterns[@]}" 2>&1)"; then
  # Fail CLOSED. An unreachable remote would otherwise report every ref as `absent` and
  # exit 0 — a vacuous green on the exact check whose job is to notice staleness.
  echo "[ERROR] check-deploy-ref-ancestry: cannot read refs from '${REMOTE}'." >&2
  printf '        %s\n' "$ls_remote_out" >&2
  exit 1
fi

declare -A REMOTE_TIP=()
while read -r sha ref; do
  [ -n "${sha:-}" ] || continue
  REMOTE_TIP["${ref#refs/heads/}"]="$sha"
done <<<"$ls_remote_out"

local_ref_for() { printf '%s/%s' "$LOCAL_NS" "${1//\//_}"; }

fetch_specs=()
for ref in "${REF_ORDER[@]}"; do
  [ -n "${REMOTE_TIP[$ref]+x}" ] || continue
  fetch_specs+=("+refs/heads/${ref}:$(local_ref_for "$ref")")
done

if [ "${#fetch_specs[@]}" -gt 0 ] && [ "${DEPLOY_REF_CHECK_SKIP_FETCH:-0}" != "1" ]; then
  # --depth=1: provenance lives in the TIP (trailer or .promote-state), never in history, so a
  # deploy branch's thousands of off-main promote commits are pure transfer cost. Shallow
  # boundaries land only on these refs; MAIN_REF keeps the full history ancestry depends on.
  git fetch --no-tags --quiet --depth=1 "$REMOTE" "${fetch_specs[@]}"
fi

# ── Per-ref resolution ───────────────────────────────────────────────────────
# Resolve the monorepo source commit a ref's tip SELECTS. Echoes "<sha>|<via>". The `|`
# separator (not whitespace) is load-bearing: an EMPTY sha is a meaningful answer — "this ref
# declares no source for its own app" — and `read` would silently swallow a leading empty
# whitespace field, turning "no provenance" into a bogus SHA and a false failure.
resolve_source() {
  local lref="$1" node="$2" sha entry

  sha="$(git log -1 --format=%B "$lref" 2>/dev/null |
    grep -oiE '^Reviewed-Source:[[:space:]]*[0-9a-f]{40}' |
    grep -oiE '[0-9a-f]{40}' | head -1 || true)"
  if [ -n "$sha" ]; then
    printf '%s|reviewed-source' "$sha"
    return 0
  fi

  if [ -n "$node" ] && git cat-file -e "${lref}:.promote-state/source-sha-by-app.json" 2>/dev/null; then
    # ROLLUP_MAP_PRESERVES_UNAFFECTED: the map retains entries for apps this ref does not
    # deploy. Read ONLY this ref's own app — another app's leftover SHA is not this ref's claim.
    entry="$(git show "${lref}:.promote-state/source-sha-by-app.json" 2>/dev/null |
      jq -r --arg n "$node" '.[$n] // ""' 2>/dev/null || true)"
    if [ -n "$entry" ]; then
      printf '%s|promote-state' "$entry"
      return 0
    fi
    printf '|promote-state-no-entry'
    return 0
  fi

  # No provenance record: the tip IS the selection. This is the shape the operator writes when
  # it CREATES a control-plane ref (POST git/refs sha=<sourceSha>, no synthetic commit yet).
  sha="$(git rev-parse "$lref" 2>/dev/null || true)"
  printf '%s|ref-tip' "$sha"
}

classify_source() {
  local sha="$1"
  if ! git cat-file -e "${sha}^{commit}" 2>/dev/null; then
    echo "UNREACHABLE"
    return 0
  fi
  if git merge-base --is-ancestor "$sha" "$MAIN_REF" 2>/dev/null; then
    echo "ON_MAIN"
    return 0
  fi
  if git merge-base --is-ancestor "$MAIN_REF" "$sha" 2>/dev/null; then
    echo "AHEAD"
    return 0
  fi
  echo "DIVERGED"
}

# Jurisdiction: which policy owns this ref. See the table in the header.
jurisdiction_for() {
  local ref="$1" node="${2:-}" env="${3:-}" kind="${4:-}"
  if [ "$kind" = "control-plane" ]; then
    echo "source-selection"
    return 0
  fi
  if [ -n "$node" ] && is_infra_target "$node"; then
    echo "no-provenance"
    return 0
  fi
  if [ -n "$node" ] && is_remote_source_artifact_target "$node"; then
    echo "foreign-source"
    return 0
  fi
  if [ "$env" = "candidate-a" ]; then
    echo "flight-slot"
    return 0
  fi
  echo "promoted-app"
}

declare -a VIOLATIONS=()
declare -a WARNINGS=()

printf '[deploy-ref-ancestry] bug.5150 — DEPLOY_REF_SOURCE_IS_REACHABLE_FROM_MAIN\n'
printf '[deploy-ref-ancestry] authority: %s @ %s   remote: %s   refs: %d\n\n' \
  "$MAIN_REF" "${MAIN_SHA:0:12}" "$REMOTE" "${#REF_ORDER[@]}"
printf '%-38s %-16s %-14s %-16s %-12s %s\n' REF JURISDICTION SOURCE VIA STATE VERDICT
printf '%-38s %-16s %-14s %-16s %-12s %s\n' \
  '--------------------------------------' '----------------' '--------------' \
  '----------------' '------------' '-------'

for ref in "${REF_ORDER[@]}"; do
  node="${REF_NODE[$ref]}"
  env="${REF_ENV[$ref]}"
  kind="${REF_KIND[$ref]}"
  juris="$(jurisdiction_for "$ref" "$node" "$env" "$kind")"

  if [ -z "${REMOTE_TIP[$ref]+x}" ]; then
    printf '%-38s %-16s %-14s %-16s %-12s %s\n' "$ref" "absent" "-" "-" "-" \
      "skip (not created yet — a born node never flighted)"
    continue
  fi

  lref="$(local_ref_for "$ref")"
  # Report the tip the provenance was actually READ FROM, not the ls-remote answer — if those
  # two ever disagree the operator must chase the object this check judged, not a newer one.
  tip="$(git rev-parse "$lref" 2>/dev/null || printf '%s' "${REMOTE_TIP[$ref]}")"
  IFS='|' read -r src via <<<"$(resolve_source "$lref" "$node")"
  if [ -z "${src:-}" ]; then
    printf '%-38s %-16s %-14s %-16s %-12s %s\n' "$ref" "no-provenance" "-" "${via}" "-" \
      "skip (declares no source for '${node:-?}')"
    continue
  fi
  if [ "$juris" = "no-provenance" ]; then
    printf '%-38s %-16s %-14s %-16s %-12s %s\n' "$ref" "$juris" "${src:0:12}" "$via" "-" \
      "skip (type:infra — Compose-on-VM, no Argo source)"
    continue
  fi
  if [ "$juris" = "foreign-source" ]; then
    printf '%-38s %-16s %-14s %-16s %-12s %s\n' "$ref" "$juris" "${src:0:12}" "$via" "-" \
      "skip (SHA belongs to $(source_repo_for_target "$node"))"
    continue
  fi

  # Only ASSERTED rows may cost a round trip. A source commit that main already contains is
  # local for free; one that is off-main is fetched individually (cheap — it shares all but the
  # unmerged delta with main) so AHEAD can be told apart from DIVERGED honestly.
  if ! git cat-file -e "${src}^{commit}" 2>/dev/null &&
    [ "${DEPLOY_REF_CHECK_SKIP_FETCH:-0}" != "1" ]; then
    git fetch --no-tags --quiet "$REMOTE" "$src" 2>/dev/null || true
  fi
  state="$(classify_source "$src")"

  if [ "$juris" = "flight-slot" ]; then
    printf '%-38s %-16s %-14s %-16s %-12s %s\n' "$ref" "$juris" "${src:0:12}" "$via" "$state" \
      "report (candidate-a is the pre-merge slot — off-main by design)"
    continue
  fi

  verdict=""
  case "$juris:$state" in
    source-selection:ON_MAIN | promoted-app:ON_MAIN)
      verdict="pass"
      ;;
    source-selection:AHEAD)
      verdict="pass (flight in progress — MERGE OR RECONCILE)"
      WARNINGS+=("${ref} selects ${src} — a reviewed, UNMERGED head. Legitimate only while its PR is open: the moment main advances past it this check goes red.")
      ;;
    *)
      verdict="FAIL"
      VIOLATIONS+=("${ref}|${tip}|${src}|${via}|${state}|${juris}")
      ;;
  esac
  printf '%-38s %-16s %-14s %-16s %-12s %s\n' "$ref" "$juris" "${src:0:12}" "$via" "$state" "$verdict"
done

echo

for warning in "${WARNINGS[@]:-}"; do
  [ -n "$warning" ] || continue
  printf '[deploy-ref-ancestry] WARN  %s\n' "$warning"
done

if [ "${#VIOLATIONS[@]}" -eq 0 ]; then
  echo "[deploy-ref-ancestry] PASS — every asserted deploy ref resolves to a source commit reachable from ${MAIN_REF}."
  exit 0
fi

echo
echo "=============================================================================="
echo " DEPLOY REF IS SERVING A COMMIT THAT IS NOT ON MAIN  (bug.5150)"
echo "=============================================================================="
for violation in "${VIOLATIONS[@]}"; do
  IFS='|' read -r v_ref v_tip v_src v_via v_state v_juris <<<"$violation"
  echo
  echo "  ref          ${v_ref}"
  echo "  ref tip      ${v_tip}"
  echo "  source sha   ${v_src}   (resolved via: ${v_via})"
  echo "  state        ${v_state}  vs  ${MAIN_REF} @ ${MAIN_SHA}"
  case "$v_state" in
    DIVERGED)
      echo "               main abandoned this line. Argo is serving a tree unreachable from main."
      ;;
    UNREACHABLE)
      echo "               no ref on ${REMOTE} reaches this commit at all — it cannot be reviewed"
      echo "               or re-derived. Strictly worse than diverged."
      ;;
    AHEAD)
      echo "               an UNMERGED commit. A promoted environment must run merged code."
      ;;
  esac
  echo "  fix"
  if [ "$v_juris" = "source-selection" ]; then
    echo "               Re-select this ref at a REAL control-plane PR head:"
    echo "                 POST /api/v1/deploy/infra-reconcile"
    echo "                 { \"nodeId\": \"<operator node UUID>\", \"env\": \"${REF_ENV[$v_ref]}\","
    echo "                   \"sourceSha\": \"<40-hex head of an open, reviewed control-plane PR>\" }"
    echo "               That verb is the sanctioned re-select; never move the ref by hand."
  else
    echo "               Re-promote this cell from a merged SHA:"
    echo "                 POST /api/v1/deploy/promote   (production is a manual, human-gated dispatch)"
    echo "               If the control plane itself is stale, re-select it first with"
    echo "                 POST /api/v1/deploy/infra-reconcile  at a real control-plane PR head."
  fi
done
echo
echo "  Why this is not cosmetic: Argo reports OutOfSync + Healthy for exactly this state, and"
echo "  the ref stays content-identical to main until the next merge touches its path — then it"
echo "  silently diverges. That is how 14c8b8d271 served a stale XComputeWorkload Composition"
echo "  with no identity block and every Crossplane CREATE came back 400 invalid_request."
echo "=============================================================================="
exit 1
