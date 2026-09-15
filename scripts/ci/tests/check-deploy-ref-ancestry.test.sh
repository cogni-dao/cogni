#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
#
# Tests for scripts/ci/check-deploy-ref-ancestry.sh (bug.5150).
#
# Hermetic: builds a throwaway "origin" repo with real commits, real deploy refs in both
# shapes the fleet uses (a `Reviewed-Source:` source-selection ref and a
# `.promote-state/source-sha-by-app.json` rendered-artifact ref), a fixture catalog, and
# fixture Argo manifests. No network — the remote is a local path, so the ls-remote + fetch
# codepath the check uses in CI is exercised for real rather than stubbed out.
#
# The load-bearing case is [2]: a ref pinned to a commit main ABANDONED (the exact shape of
# 14c8b8d271) must make this check exit non-zero and name the fix verb. A suite that only
# proves green would have passed on the day of the incident.
#
# Run: bash scripts/ci/tests/check-deploy-ref-ancestry.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
CHECK="$REPO_ROOT/scripts/ci/check-deploy-ref-ancestry.sh"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
pass() { echo "  ok — $*"; }

ORIGIN="$WORK/origin"
CLONE="$WORK/clone"
FIXTURE="$WORK/fixture"
CATALOG="$FIXTURE/infra/catalog"
ARGOCD="$FIXTURE/infra/k8s/argocd"

g() { git -C "$ORIGIN" "$@"; }

commit_file() {
  # commit_file <path> <content> <message>
  mkdir -p "$(dirname "$ORIGIN/$1")"
  printf '%s\n' "$2" >"$ORIGIN/$1"
  g add -A
  g -c user.name=t -c user.email=t@t commit -q -m "$3"
  g rev-parse HEAD
}

# ── Build the origin repo ────────────────────────────────────────────────────
mkdir -p "$ORIGIN"
g init -q -b main
g config commit.gpgsign false

commit_file README.md v0 "root" >/dev/null
MAIN_1="$(commit_file README.md v1 'main 1')"

# An ABANDONED line: cut from main@MAIN_1, never merged, then main moved on. This is exactly
# what a squash-merge leaves behind and exactly the state 14c8b8d271 was in.
g checkout -q -b abandoned "$MAIN_1"
ORPHAN="$(commit_file README.md orphan 'abandoned PR head')"
g checkout -q main

MAIN_2="$(commit_file README.md v2 'main 2')"
MAIN_3="$(commit_file README.md v3 'main 3')"

# A live flight: a descendant of the CURRENT main tip — main + a reviewable delta.
g checkout -q -b inflight "$MAIN_3"
INFLIGHT="$(commit_file README.md inflight 'open reviewed PR head')"
g checkout -q main

# Source-selection refs: synthetic commit, tree of the selection, Reviewed-Source trailer.
select_ref() {
  # select_ref <branch> <selected-sha>
  local branch="$1" sha="$2" tree commit
  tree="$(g rev-parse "${sha}^{tree}")"
  commit="$(g -c user.name=t -c user.email=t@t commit-tree "$tree" \
    -m "chore(candidate-a): select control-plane ${sha:0:12}

Reviewed-PR: #1
Reviewed-Source: ${sha}")"
  g update-ref "refs/heads/${branch}" "$commit"
}

# Rendered-artifact refs: full tree + .promote-state provenance, committed off main.
promote_ref() {
  # promote_ref <branch> <app> <source-sha> [extra-app] [extra-sha]
  local branch="$1" app="$2" sha="$3" extra_app="${4:-}" extra_sha="${5:-}" json
  json="{\"${app}\":\"${sha}\""
  [ -n "$extra_app" ] && json="${json},\"${extra_app}\":\"${extra_sha}\""
  json="${json}}"
  g checkout -q -B "$branch" "$MAIN_1"
  mkdir -p "$ORIGIN/.promote-state"
  printf '%s\n' "$json" >"$ORIGIN/.promote-state/source-sha-by-app.json"
  g add -A
  g -c user.name=t -c user.email=t@t commit -q -m "promote ${branch}: ${sha:0:8}"
  g checkout -q main
}

# ── Fixture catalog + Argo manifests ─────────────────────────────────────────
mkdir -p "$CATALOG" "$ARGOCD/control-plane/candidate-a"

cat >"$CATALOG/operator.yaml" <<'YAML'
name: operator
type: node
is_primary_host: true
candidate_a_branch: deploy/candidate-a-operator
preview_branch: deploy/preview-operator
production_branch: deploy/production-operator
YAML

cat >"$CATALOG/newborn.yaml" <<'YAML'
name: newborn
type: node
candidate_a_branch: deploy/candidate-a-newborn
preview_branch: deploy/preview-newborn
production_branch: deploy/production-newborn
YAML

cat >"$CATALOG/faraway.yaml" <<'YAML'
name: faraway
type: node
source_repo: https://github.com/cogni-dao/faraway.git
candidate_a_branch: deploy/candidate-a-faraway
preview_branch: deploy/preview-faraway
production_branch: deploy/production-faraway
YAML

cat >"$ARGOCD/control-plane/candidate-a/root.yaml" <<'YAML'
apiVersion: argoproj.io/v1alpha1
kind: Application
spec:
  source:
    targetRevision: deploy/candidate-a-control-plane
YAML

# A TEMPLATED revision is a family, not a ref — plane 1 already owns those cells.
cat >"$ARGOCD/control-plane/candidate-a/appset.yaml" <<'YAML'
apiVersion: argoproj.io/v1alpha1
kind: ApplicationSet
spec:
  template:
    spec:
      source:
        targetRevision: "deploy/candidate-a-{{.name}}"
YAML

run_check() {
  (
    cd "$CLONE"
    COGNI_CATALOG_ROOT="$CATALOG" \
      COGNI_ARGOCD_ROOT="$ARGOCD" \
      GITHUB_REPOSITORY="cogni-dao/cogni" \
      DEPLOY_REF_CHECK_REMOTE=origin \
      DEPLOY_REF_CHECK_MAIN_REF=origin/main \
      bash "$CHECK" 2>&1
  )
}

reclone() {
  rm -rf "$CLONE"
  git clone -q --no-checkout "$ORIGIN" "$CLONE"
  git -C "$CLONE" fetch -q --no-tags origin '+refs/heads/main:refs/remotes/origin/main'
}

# ═══ 1. GREEN: every asserted ref resolves to a commit on main ═══════════════
echo "[1/9] green — selection on main, promoted apps on main"
select_ref deploy/candidate-a-control-plane "$MAIN_2"
promote_ref deploy/preview-operator operator "$MAIN_2"
promote_ref deploy/production-operator operator "$MAIN_1"
promote_ref deploy/candidate-a-operator operator "$ORPHAN"
promote_ref deploy/candidate-a-faraway faraway "$ORPHAN"
promote_ref deploy/preview-faraway faraway "$ORPHAN"
promote_ref deploy/production-faraway faraway "$ORPHAN"
reclone

OUT="$(run_check)" || fail "expected exit 0 on an all-on-main fleet:
$OUT"
grep -q 'PASS —' <<<"$OUT" || fail "no PASS line:
$OUT"
grep -qE 'deploy/preview-operator +promoted-app +[0-9a-f]+ +promote-state +ON_MAIN +pass' <<<"$OUT" ||
  fail "preview-operator not asserted ON_MAIN:
$OUT"
pass "exit 0; promoted-app rows asserted ON_MAIN"

# ═══ 2. RED-PROOF: a selection main ABANDONED (the bug.5150 shape) ═══════════
echo "[2/9] RED — source-selection ref pinned to an abandoned commit"
select_ref deploy/candidate-a-control-plane "$ORPHAN"
reclone

set +e
OUT="$(run_check)"
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "check stayed GREEN on an abandoned selection — this is the defect:
$OUT"
grep -q 'DIVERGED' <<<"$OUT" || fail "state not reported DIVERGED:
$OUT"
grep -q 'deploy/candidate-a-control-plane' <<<"$OUT" || fail "failure does not name the ref:
$OUT"
grep -q "$ORPHAN" <<<"$OUT" || fail "failure does not name the source SHA:
$OUT"
grep -q 'POST /api/v1/deploy/infra-reconcile' <<<"$OUT" || fail "failure does not name the fix verb:
$OUT"
grep -q '"env": "candidate-a"' <<<"$OUT" || fail "fix verb does not carry the right env:
$OUT"
pass "exit ${RC}; names ref + SHA + DIVERGED + infra-reconcile"

# ═══ 3. RED: a promoted app whose promote-state SHA is off main ══════════════
echo "[3/9] RED — production app promoted from an off-main SHA"
select_ref deploy/candidate-a-control-plane "$MAIN_2"
promote_ref deploy/production-operator operator "$ORPHAN"
reclone

set +e
OUT="$(run_check)"
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "check stayed GREEN on a production app promoted off main:
$OUT"
grep -q 'POST /api/v1/deploy/promote' <<<"$OUT" || fail "promoted-app fix verb missing:
$OUT"
pass "exit ${RC}; names the re-promote verb"

# ═══ 4. RED: an unmerged (AHEAD) commit serving production ═══════════════════
echo "[4/9] RED — production app promoted from an UNMERGED descendant of main"
promote_ref deploy/production-operator operator "$INFLIGHT"
reclone

set +e
OUT="$(run_check)"
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "AHEAD accepted for a promoted env — prod must run merged code:
$OUT"
grep -q 'AHEAD' <<<"$OUT" || fail "state not reported AHEAD:
$OUT"
pass "exit ${RC}; AHEAD is a violation for promoted-app"

# ═══ 5. GREEN + WARN: a flight in progress on the source-selection ref ═══════
echo "[5/9] green+warn — selection AHEAD of main (open reviewed PR)"
select_ref deploy/candidate-a-control-plane "$INFLIGHT"
promote_ref deploy/production-operator operator "$MAIN_1"
reclone

OUT="$(run_check)" || fail "a live flight must not fail the build:
$OUT"
grep -q 'AHEAD' <<<"$OUT" || fail "flight not classified AHEAD:
$OUT"
grep -q 'WARN' <<<"$OUT" || fail "flight passed SILENTLY — it must be reported loudly:
$OUT"
pass "exit 0 with an explicit WARN, never a silent pass"

# ═══ 6. Absent ref must not fail the build ══════════════════════════════════
echo "[6/9] absent — a born node that was never flighted"
OUT="$(run_check)" || fail "unexpected failure:
$OUT"
grep -qE 'deploy/preview-newborn +absent .*not created yet' <<<"$OUT" ||
  fail "newborn's missing refs not reported as absent:
$OUT"
pass "reported as absent, build stays green"

# ═══ 7. Out-of-jurisdiction rows are reported, never silently dropped ═══════
echo "[7/9] jurisdiction — flight-slot + foreign-source are reported with a reason"
grep -qE 'deploy/candidate-a-operator +flight-slot +[0-9a-f]+ +promote-state +DIVERGED' <<<"$OUT" ||
  fail "candidate-a slot not reported (off-main by design, but must still be printed):
$OUT"
grep -qE 'deploy/production-faraway +foreign-source' <<<"$OUT" ||
  fail "remote-source node not reported as foreign-source:
$OUT"
if grep -q 'deploy/candidate-a-{{.name}}' <<<"$OUT"; then
  fail "a TEMPLATED Argo revision was enumerated as a real ref:
$OUT"
fi
pass "reported with reasons; templated Argo revisions are not refs"

# ═══ 8. A promote-state map with no entry for THIS ref's own app ════════════
# ROLLUP_MAP_PRESERVES_UNAFFECTED: the map keeps entries for apps a ref does not deploy.
# Another app's SHA is not this ref's claim, and an empty provenance answer must report
# `no-provenance` — never get mis-parsed into a bogus SHA and a false failure.
echo "[8/9] no-provenance — promote-state map carries only a FOREIGN app's entry"
promote_ref deploy/preview-operator faraway "$ORPHAN"
reclone

OUT="$(run_check)" || fail "a leftover foreign entry must not be read as this ref's source:
$OUT"
grep -qE "deploy/preview-operator +no-provenance .*declares no source for 'operator'" <<<"$OUT" ||
  fail "empty provenance not reported as no-provenance:
$OUT"
if grep -q "$ORPHAN" <<<"$OUT"; then
  fail "read ANOTHER app's leftover SHA as this ref's source:
$OUT"
fi
pass "reported no-provenance; the foreign entry is not borrowed"

# ═══ 9. Fail CLOSED when the remote cannot be read ══════════════════════════
# The nastiest failure mode for this check is a vacuous green: an unreadable remote makes
# every ref look `absent`, and `absent` is deliberately not a failure.
echo "[9/9] fail-closed — unreachable remote must not read as an empty fleet"
set +e
OUT="$(
  cd "$CLONE" &&
    COGNI_CATALOG_ROOT="$CATALOG" COGNI_ARGOCD_ROOT="$ARGOCD" \
      GITHUB_REPOSITORY="cogni-dao/cogni" \
      DEPLOY_REF_CHECK_REMOTE="$WORK/no-such-remote" \
      DEPLOY_REF_CHECK_MAIN_REF=origin/main \
      bash "$CHECK" 2>&1
)"
RC=$?
set -e
[ "$RC" -ne 0 ] || fail "unreadable remote produced a GREEN run:
$OUT"
grep -q 'cannot read refs' <<<"$OUT" || fail "no diagnostic for the unreadable remote:
$OUT"
pass "exit ${RC}; refuses to judge a fleet it could not read"

echo
echo "PASS: check-deploy-ref-ancestry (9/9)"
