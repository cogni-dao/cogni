#!/usr/bin/env bash
set -euo pipefail

# flight-preview.sh — request a preview flight for a merged-PR SHA.
#
# This script does NOT perform the deploy — it is a dispatcher. It delegates
# the actual promote/deploy/verify/e2e work to promote-and-deploy.yml via
# `gh workflow run`, scoped to env=preview.
#
# Called by flight-preview.yml after a PR merges to main (or via manual
# workflow_dispatch). The PR merge gate is authoritative — no external CI
# polling happens here. Serialization of bursty merges is handled by the
# `flight-preview` workflow concurrency group and promote-and-deploy.yml's
# own per-env concurrency group; preview always tracks the latest merged SHA
# (latest-wins), with no human-review hold.
#
# Exit codes:
#   0 — flight dispatched (promote-and-deploy kicked off for the given SHA)
#   1 — hard failure (missing token, unexpected error)
#
# Usage: flight-preview.sh <sha> <repo> <deploy-branch> <gh-token> <build-sha> [nodes-csv]
#
# GH Actions integration: when invoked inside a GitHub Actions step, the
# runner sets $GITHUB_OUTPUT and $GITHUB_STEP_SUMMARY. This script writes a
# `status=dispatched` line to $GITHUB_OUTPUT and a markdown banner to
# $GITHUB_STEP_SUMMARY so the workflow can gate downstream jobs on the output
# and operators get a visible outcome in the job summary.
#
# Positional args 1–4 are required; arg 5 (build-sha = PR branch head SHA)
# is required for squash-merge correctness but has an env + arg-1 fallback
# to keep CLI/test callers working. If you add a new caller, pass build-sha
# explicitly — the bug.0361 SHA-mismatch regression returns if it silently
# falls back to SHA (the main merge commit). Arg 3 (deploy-branch) is retained
# for caller/signature compatibility but is no longer used (the lease it once
# guarded was removed).

SHA="${1:?Usage: flight-preview.sh <sha> <repo> <deploy-branch> <gh-token> <build-sha> [nodes-csv]}"
REPO="${2:?}"
DEPLOY_BRANCH="${3:-deploy/preview}"  # retained for compat; unused
GH_TOKEN="${4:-${GH_TOKEN:-}}"
BUILD_SHA="${5:-${BUILD_SHA:-$SHA}}"
# task.0376: scope promote-and-deploy.yml's matrix to affected nodes.
# Empty (legacy callers) → promote-and-deploy.yml falls back to ALL_TARGETS.
NODES_CSV="${6:-${NODES_CSV:-}}"

# Emit `status=<value>` to $GITHUB_OUTPUT when running under Actions.
# No-op from a plain shell so CLI/test callers aren't surprised.
emit_status() {
  local value="$1"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "status=${value}" >> "$GITHUB_OUTPUT"
  fi
}

# Append a markdown outcome block to $GITHUB_STEP_SUMMARY when running
# under Actions.
emit_summary() {
  local outcome="$1" detail="$2"
  if [ -z "${GITHUB_STEP_SUMMARY:-}" ]; then
    return 0
  fi
  {
    echo "## Flight Preview"
    echo ""
    echo "- Outcome: **${outcome}**"
    echo "- SHA: \`${SHORT_SHA:-unknown}\`"
    echo "- Detail: ${detail}"
  } >> "$GITHUB_STEP_SUMMARY"
}

# Emit `<name>=<value>` to $GITHUB_OUTPUT when running under Actions.
# No-op from a plain shell so CLI/test callers aren't surprised.
emit_output() {
  local name="$1" value="$2"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "${name}=${value}" >> "$GITHUB_OUTPUT"
  fi
}

# Resolve the URL of the promote-and-deploy run that THIS dispatch just spawned
# and surface it (clickable) to the step summary + a job output, so operators
# don't have to hand-hunt `gh run list`.
#
# `gh workflow run` returns no run id, and the spawned run takes a few seconds
# to appear — so we poll `gh run list` for the newest workflow_dispatch run
# created at/after the dispatch timestamp ($1, UTC ISO-8601). This is purely
# observational: a resolution miss emits a LOUD ::warning:: but NEVER fails the
# job — the dispatch itself already succeeded.
surface_spawned_run_url() {
  local dispatched_at="$1"
  local list_url="https://github.com/${REPO}/actions/workflows/promote-and-deploy.yml"
  local attempts=6 delay=5 i run_json run_url

  for ((i = 1; i <= attempts; i++)); do
    # Newest dispatch run created at/after our pre-dispatch timestamp wins.
    run_json=$(gh run list \
      --repo "$REPO" \
      --workflow=promote-and-deploy.yml \
      --event workflow_dispatch \
      --limit 5 \
      --json databaseId,createdAt,url,headSha 2>/dev/null || echo '[]')
    run_url=$(printf '%s' "$run_json" | jq -r --arg ts "$dispatched_at" \
      '[.[] | select(.createdAt >= $ts)] | sort_by(.createdAt) | last | .url // empty' 2>/dev/null || echo "")
    if [ -n "$run_url" ]; then
      echo "🔗 Spawned promote-and-deploy run: ${run_url}"
      emit_output "spawned_run_url" "$run_url"
      if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
        {
          echo ""
          echo "- Spawned run: [promote-and-deploy](${run_url})"
        } >> "$GITHUB_STEP_SUMMARY"
      fi
      return 0
    fi
    [ "$i" -lt "$attempts" ] && sleep "$delay"
  done

  local budget=$((attempts * delay))
  echo "::warning::Preview flight dispatched OK but could not resolve the spawned promote-and-deploy run URL within ${budget}s — find it at ${list_url}"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    {
      echo ""
      echo "- ⚠️ Spawned run URL unresolved within ${budget}s — find it in the [promote-and-deploy run list](${list_url})"
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  return 0
}

if [ -z "$GH_TOKEN" ]; then
  echo "❌ GH_TOKEN required (arg 4 or env)"
  exit 1
fi
export GH_TOKEN

SHORT_SHA="${SHA:0:8}"

echo "🚀 Dispatching promote-and-deploy env=preview for ${SHORT_SHA} (nodes=${NODES_CSV:-all})..."
# Capture a UTC timestamp BEFORE the dispatch so we can identify the run this
# call spawns (gh workflow run returns no run id). Trim sub-second precision so
# the >= filter is robust against gh's ISO-8601 createdAt granularity.
DISPATCHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
gh workflow run promote-and-deploy.yml \
  --repo "$REPO" \
  --ref main \
  -f environment=preview \
  -f source_sha="$SHA" \
  -f build_sha="$BUILD_SHA" \
  -f nodes="$NODES_CSV" \
  -f skip_infra=true
echo "✅ Preview flight dispatched for ${SHORT_SHA}"
emit_status "dispatched"
emit_summary "dispatched" "promote-and-deploy kicked off; \`deploy-preview\` job in this workflow will run."

# Surface the spawned run's clickable URL (best-effort; never fails the job).
surface_spawned_run_url "$DISPATCHED_AT"

exit 0
