---
id: task.5054
type: handoff
work_item_id: task.5054
status: implementation-review
created: 2026-05-19
updated: 2026-05-19
branch: derekg1729/dolt-branch-edits
last_commit: 203f7d2de
---

# Handoff: Dolt Knowledge Branch Edit Flow

## Context

- `task.5054` is about a PR-like Dolt knowledge contribution workflow, not just one-shot row creation.
- North star: internal trusted writes go to `main`; external/agent contributions use reviewable `contrib/*` branches.
- Branches must support iterative agent work: 2, 5, 10 commits on the same open branch.
- We want a stable Cogni wrapper around Dolt primitives, not a DoltHub clone.
- New nodes should be able to fork this workflow as the default knowledge-hub
  pattern, but template schema changes must land in a node-template-scoped work
  item because `single-node-scope` blocks mixed operator + node-template PRs.

## Current State

- PR #1343 exists: https://github.com/Cogni-DAO/cogni/pull/1343
- PR #1343 now contains the first multi-commit contribution branch implementation:
  typed edit batches, `base_commit` / `head_commit` / `commit_count`,
  `knowledge_contribution_commits`, and append/list commit endpoints.
- `targetRowId` is no longer the contribution model. It is scoped to
  `update`/`deprecate` edits.
- Inserts may carry a client-supplied stable `id`; use that when later commits
  need to update the inserted row without an extra diff lookup.
- Owner-close remains allowed. Merge remains session-gated.
- Candidate flight is blocked by `bug.5066`: production `/api/v1/vcs/flight` returned HTTP 500 for PR #1343.

## Decisions Made

- External branch review should mirror code PRs: branch, commits, diff, merge, close.
- Review should use `dolt_diff(base_commit, head_commit, "knowledge")` so the
  review artifact does not drift when `main` advances after branch creation.
- Merge remains session-gated; bearer agents can contribute and close their own branches, but cannot merge to `main`.
- Cogni metadata is an attribution index. Dolt remains source of truth for branch
  heads, diffs, merge behavior, and row history.
- Appends must advance the recorded branch head and claim a unique sequence.

## Next Actions

- [x] Re-read `docs/design/knowledge-branch-workflow.md`.
- [x] Replace one-shot `commit_hash` model with branch base/head + timeline.
- [x] Add `knowledge_contribution_commits`.
- [x] Add `POST /api/v1/knowledge/contributions/:id/commits`.
- [x] Track `base_commit`, `head_commit`, and `commit_count` on `knowledge_contributions`.
- [x] Add `GET /api/v1/knowledge/contributions/:id/commits`.
- [ ] Add Doltgres component coverage for create -> append three commits -> diff -> merge.
- [ ] Add an append race test proving stale/parallel appends return 409.
- [ ] File a node-template-scoped follow-up to align
      `nodes/node-template/packages/knowledge/src/schema.ts` with
      `base_commit` / `head_commit` / `commit_count` and
      `knowledge_contribution_commits`.
- [ ] Resolve or work around `bug.5066` before candidate validation.

## Risks / Gotchas

- Do not re-add unrelated fixes to this PR; the internship-interest test gate was baseline drift and should be handled separately.
- Do not mix node-template schema edits into this operator-scoped PR; CI
  `single-node-scope` rejects that.
- Dolt checkout operations must stay on a reserved connection.
- Update/deprecate target validation must happen on the contribution branch, not
  `main`, so commit 2 can update a row created by commit 1.
- Process-local append serialization is not a distributed lock. If operator runs
  multiple writers for the same contribution, add a DB lease/advisory lock.
- Keep the wrapper small; avoid branch browser/rebase/comment-thread scope.

## Pointers

| File / Resource                                                          | Why it matters                                                         |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `docs/design/knowledge-branch-workflow.md`                               | Simple workflow and invariants for the next implementation.            |
| `docs/design/knowledge-contribution-api.md`                              | API, metadata, contract, and adapter boundary for the branch workflow. |
| `docs/spec/knowledge-data-plane.md`                                      | Governing Doltgres knowledge-plane split.                              |
| `docs/spec/knowledge-syntropy.md`                                        | Governing compounding/provenance/confidence rules.                     |
| `packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts` | Current branch create/diff/merge/close implementation.                 |
| `packages/knowledge-store/src/service/contribution-service.ts`           | Current policy gate for merge/close.                                   |
| `packages/node-contracts/src/knowledge.contributions.v1.contract.ts`     | Current public contribution wire contract.                             |
| `bug.5066`                                                               | Flight gate blocker for PR #1343 candidate validation.                 |
