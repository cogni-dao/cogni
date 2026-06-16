---
id: bug.0377
type: bug
title: "require-pinned-release-prs-to-main.yml matches non-release PRs"
status: needs_implement
priority: 1
rank: 30
estimate: 1
summary: "The release-pin enforcement workflow currently runs on every PR targeting main, not just release/* PRs, so feature PRs hit a red `require-pinned-release-branch` check and operators learn to ignore it. Scope the matcher to head_ref `release/*` only — keep the SHA-pin assertion on actual release PRs intact (load-bearing for the prod = preview-validated invariant)."
outcome: |
  - `require-pinned-release-prs-to-main.yml` triggers only on PRs whose head ref matches `release/*`. Feature PRs no longer carry a red `require-pinned-release-branch` status.
  - For real release PRs (`release/YYYYMMDD-<sha>` cut by `release.yml`), the SHA-pin assertion is unchanged — prod still equals preview-validated digests.
  - One-line change in the workflow `on:` filter (or first-step early-exit) — no script edits, no spec changes.
spec_refs:
  - docs/spec/ci-cd.md
assignees: []
project: proj.cicd-services-gitops
branch:
pr:
created: 2026-04-25
updated: 2026-04-25
labels: [cicd, ci-noise]
external_refs:
  - work/projects/proj.cicd-services-gitops.md (blocker #8 / row 8)
---

# bug.0377 — release-pin gate matches non-release PRs

## Problem

`.github/workflows/require-pinned-release-prs-to-main.yml` enforces "release PRs into main must pin a SHA from `deploy/preview:.promote-state/current-sha`". It is the load-bearing gate that keeps `prod = preview-validated`. **Do not delete it.**

The bug: it triggers on every PR to `main`, not just `release/*` PRs. Feature branches (which never carry a release pin and aren't supposed to) get a red `require-pinned-release-branch` check on every push. Two consequences:

1. Operators (human + agent) learn to ignore that check, eroding the gate's signal.
2. Mergeability hints in the GitHub UI go yellow/red on healthy PRs, masking real failures.

Visible in PR #868 and PR #857 (both feature PRs, both red `require-pinned-release-branch`).

## Fix

Scope the trigger. Either:

- `on: pull_request: { branches: [main], head_branch: ['release/*'] }` (preferred — workflow doesn't run at all on non-release PRs, no skipped status posted), OR
- Keep the current trigger but early-exit with `if: startsWith(github.head_ref, 'release/')` on the only job, so non-release PRs see a visibly-skipped (grey) check rather than red.

Option A is cleaner and aligns with how `flight-preview.yml` already gates dispatch vs queue.

## Validation

- (a) Open a feature PR to main; `require-pinned-release-branch` does not appear (option A) or appears grey/skipped (option B).
- (b) `release.yml` cuts `release/YYYYMMDD-<sha>` and opens a PR; the gate runs and passes when the body pins a valid `current-sha`.
- (c) Manually open a PR from `release/2026-bogus` with no SHA pin in the body; gate fails red. (Negative test — load-bearing assertion still works.)

## Out of scope

- Any change to what the gate asserts. The pin enforcement is correct; only the trigger scope is wrong.
- Migration off PR-based release flow. `release.yml` → release PR → main is the current contract per project blocker resolution; preserved here.
