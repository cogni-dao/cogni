You are closing out a validated work item: #$ITEM

Closeout is the last stage: the change is reviewed, green and proven on candidate. Your job is to land it, close the item, and keep what was learned. You do not change code here; if anything below fails, return the item to the stage that owns the failure.

Read the work item (`GET /api/v1/work/items/{id}`), its PR, and [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence).

---

## Phase 1 — Verify every gate at one SHA

Let `HEAD_SHA` be the PR head (`gh pr view <PR> --json headRefOid`). All three must hold for that exact SHA:

1. **CI**: every required check passes (`gh api repos/{owner}/{repo}/commits/$HEAD_SHA/check-runs`).
2. **Review**: the latest `/review-implementation` verdict on the PR names `HEAD_SHA` and says APPROVE.
3. **Validation**: the `/validate-candidate` scorecard on the PR names `HEAD_SHA` and passes, or records flight n/a for an instruction-only change.

If any gate fails or names an older SHA, stop: set the item back to `needs_merge` and name the missing gate.

---

## Phase 2 — Land it

1. Merge through the operator: `POST /api/v1/vcs/merge` with `{nodeId, prNumber}`. Never use `gh pr merge`.
2. Watch until the PR is `MERGED`; a queued merge is not done.
3. `PATCH /api/v1/work/items/{id}` with `{"set":{"status":"done"}}`.
4. Preview follows `main`: confirm preview `/version.buildSha` reaches the merge SHA. Production promotion of a user-facing change waits for a human to look at it.

---

## Phase 3 — Keep what was learned

Ask: did this work produce durable knowledge a future agent would need, such as a gotcha, a corrected assumption, or a design that drifted? If yes, refine the owning hub entry through [`contribute-knowledge-to-cogni`](../skills/contribute-knowledge-to-cogni/SKILL.md) in one focused inbox, and link it from the PR. Routine progress is not knowledge; stay silent when nothing qualifies.

If the review found a mechanical mistake that a lint rule or regression test could catch next time, file one `task` for that guardrail.

---

## Phase 4 — Report

Report the merged SHA, the preview `/version` result, the work item's `done` status, and any knowledge inbox or guardrail task. If you are inside a dev-manager story, the manager reads this report.

---

## Rules

- **ONE_SHA** — CI, review and validation must all name the same head SHA
- **OPERATOR_MERGES** — merge only through `POST /api/v1/vcs/merge`
- **DONE_MEANS_MERGED** — `done` is set only after the PR is merged
- **NO_CODE_IN_CLOSEOUT** — a needed code or doc change goes back to `needs_implement`
- **KNOWLEDGE_IS_REFINED** — refine the owning hub entry; never add a duplicate
