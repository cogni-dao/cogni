---
id: knowledge-branch-workflow
type: design
title: "Knowledge Branch Workflow"
status: draft
spec_refs:
  - knowledge-data-plane-spec
  - knowledge-syntropy
work_items:
  - task.5054
created: 2026-05-19
---

# Knowledge Branch Workflow

> The node knowledge hub should feel like code review, not like a DoltHub clone.

This document owns the user model, invariants, and acceptance criteria for
reviewable knowledge work. The HTTP contracts, port shape, adapter methods, and
metadata tables live in
[knowledge-contribution-api](./knowledge-contribution-api.md).

## Goal

Support compounding Dolt-backed knowledge with a small, stable wrapper that every
agentic node can fork:

```text
trunk knowledge on main
  + short-lived contribution branches
  + many commits per branch
  + row/file edits on that branch
  + diff review
  + session-gated merge
  + confidence/citation promotion after merge
```

## Human Model

Use the monorepo mental model:

```text
main = trusted knowledge trunk
branch = proposal / working copy
commit = one meaningful edit batch
diff = review artifact
merge = approval into trusted knowledge
close = abandon proposal
```

We do not rebuild DoltHub. Dolt already owns branch, commit, diff, and merge.
Cogni owns the contract around those primitives.

## Dolt Boundary

Dolt stores the commit graph. Cogni stores only the application context Dolt
does not know: contributor principal, auth source, contribution state, merge
authority, and syntropy validation results.

Use native Dolt primitives:

| Need           | Dolt primitive                                                                                                                                                                     | Cogni wrapper responsibility                                  |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Working copy   | Branches via `DOLT_BRANCH()` / `DOLT_CHECKOUT()` ([Doltgres functions](https://docs.doltgres.com/reference/version-control/dolt-sql-functions))                                    | Name `contrib/*` branches and gate who can write them.        |
| Audit trail    | Dolt commits and commit graph ([Dolt version control](https://docs.dolthub.com/sql-reference/version-control))                                                                     | Link app principals to selected commit hashes.                |
| Review diff    | `DOLT_DIFF()` row diff, including branch revisions and three-dot PR-style diffs ([Doltgres `DOLT_DIFF()`](https://docs.doltgres.com/reference/version-control/dolt-sql-functions)) | Return a stable JSON projection for clients.                  |
| Merge          | Dolt merge, including fast-forward and merge commits ([Dolt merge](https://docs.dolthub.com/concepts/dolt/git/merge))                                                              | Require session authority and map conflicts to HTTP statuses. |
| Branch cleanup | `DOLT_BRANCH('-d' / '-D', ...)`                                                                                                                                                    | Close metadata and preserve the audit pointer.                |

Do not build a parallel commit log, branch browser, rebase engine, merge engine,
or review-comment system. If Dolt can answer the question from the commit graph,
Cogni should store a pointer, not a duplicate.

## Workflows

### Internal Trusted Write

Internal node tools may write directly to `main` when the actor is trusted by the
node runtime.

```text
core__knowledge_write
  -> validate domain/provenance
  -> insert/update on main
  -> dolt_commit
```

Use this for node-owned automation and post-review promotion work.

### External Contribution

External agents and less-trusted automation use branch review.

```text
POST /knowledge/contributions
  -> create contrib/<principal>-<id> from main
  -> optionally apply first commit
  -> state=open

POST /knowledge/contributions/:id/commits
  -> owner only while open
  -> serialize append for that contribution
  -> reject if branch head no longer matches recorded head
  -> checkout existing branch
  -> apply inserts/updates/deprecations
  -> dolt_commit(message)
  -> record next seq + attribution pointer

GET /knowledge/contributions/:id/diff
  -> dolt_diff(base_commit, head_commit) from Dolt, projected to JSON

POST /knowledge/contributions/:id/merge
  -> session user only
  -> dolt_merge(branch)
  -> state=merged

POST /knowledge/contributions/:id/close
  -> owner or session user
  -> state=closed
  -> delete branch after state is committed
```

## Review Model

For review, prefer Dolt's PR-style diff semantics over hand-rolled staging
logic. The v0 implementation uses the recorded fork point and head:
`DOLT_DIFF(base_commit, head_commit ?? base_commit, 'knowledge')`. That gives
reviewers the cumulative branch change without drifting when `main` advances.
If Doltgres later supports the exact three-dot form we want, the API can adopt
it behind the adapter without changing clients.

This mirrors normal CI/CD branch practice: each commit is attributable, checks
run on the branch head, and merge authority is separate from write authority.
GitHub status checks use external CI results on pull-request commits and can be
required before merge
([GitHub status checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/about-status-checks)).
Knowledge contributions should follow that shape without copying GitHub:
validate each commit batch on write, show Dolt's cumulative branch diff for
review, and require session authority before trunk merge.

## Syntropy Alignment

Knowledge syntropy is about compounding, cited, attributable knowledge. Branch
iteration must preserve that:

- Every commit is one coherent edit batch, not a bag of unrelated changes.
- Every append advances the branch from the recorded head; stale or parallel
  appends fail with a conflict instead of silently claiming the same sequence.
- Inserts that later commits need to update should provide a stable row `id`;
  server-generated IDs are discoverable through the branch diff, not guessed.
- Every insert/update keeps provenance; branch updates may change the latest
  source pointer, while Dolt history preserves prior values.
- Deprecation is explicit. A contribution deprecates or supersedes knowledge; it
  does not delete it.
- The app records who authored each contribution commit because Dolt commits do
  not carry Cogni auth/session context.
- Merge promotes branch knowledge into trusted `main`; confidence/citation
  promotion can happen during or after merge, but the merge itself stays a Dolt
  merge.

## What Cogni Adds

The minimal Cogni layer is:

- Contribution lifecycle state: `open`, `merged`, `closed`.
- Principal attribution: owner, commit author, resolver.
- HTTP policy: owner can append/close; session user can merge.
- Syntropy validation: domain registered, provenance present, update targets
  valid on the branch, deprecate-not-delete.
- JSON projections for clients: contribution record, commit timeline, review
  diff.

The exact data model and routes are specified in
[knowledge-contribution-api](./knowledge-contribution-api.md).

## Invariants

| Rule                                | Constraint                                                                    |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| DOLT_IS_SOURCE_OF_TRUTH             | Doltgres `main` is the trusted knowledge state.                               |
| INTERNAL_WRITES_TO_MAIN             | Trusted internal tools may write directly to `main`.                          |
| EXTERNAL_WRITES_TO_BRANCH           | External contributors write to `contrib/*` branches only.                     |
| CONTRIBUTION_BRANCH_IS_MULTI_COMMIT | An open contribution branch can receive many commits before merge.            |
| COMMIT_IS_LOGICAL_BATCH             | Each contribution commit has one message and one coherent edit batch.         |
| APPEND_ADVANCES_RECORDED_HEAD       | An append starts from the contribution's recorded branch head or conflicts.   |
| COMMIT_SEQUENCE_IS_UNIQUE           | A contribution cannot record two commits with the same sequence number.       |
| INSERT_ID_IS_STABLE                 | Inserts may carry client-supplied IDs for later branch-local updates.         |
| TARGET_ROW_REQUIRED_FOR_UPDATE      | Updating/deprecating existing knowledge requires a valid branch-local target. |
| REVIEW_DIFF_IS_DOLT_DIFF            | Review uses Dolt diff primitives, not hand-rolled staging comparison.         |
| MERGE_REQUIRES_SESSION              | Bearer agents cannot merge to `main`; session users can.                      |
| OWNER_CAN_CLOSE                     | A branch owner can close their own open contribution.                         |
| OWNER_CAN_APPEND                    | A branch owner can append commits while the contribution is open.             |
| DEPRECATE_NOT_DELETE                | Knowledge rows are deprecated/superseded, not deleted.                        |
| PROVENANCE_REQUIRED                 | Every inserted or updated row keeps source/provenance.                        |
| DOMAIN_REGISTERED                   | Every edited row must reference a registered domain.                          |
| ATTRIBUTION_INDEX_ONLY              | Cogni metadata points to Dolt commits; it does not replace Dolt history.      |

## Pareto MVP

Build only this next:

1. Add a contribution-commit timeline that points to Dolt commit hashes.
2. Add `POST /knowledge/contributions/:id/commits`.
3. Add `GET /knowledge/contributions/:id/commits`.
4. Track branch base/head and commit count on the contribution record.
5. Require append sequencing to advance the recorded branch head.
6. Make `GET /diff` project Dolt's branch diff for review.
7. Keep merge/close policies unchanged.

Do not build:

- web branch browsing
- Dolt remote management
- rebase UI
- comments/review threads
- generalized file explorer
- per-commit clickable diff timeline in the UI (see vNext)

### vNext (explicitly out of MVP)

- **Per-commit clickable diff timeline.** MVP surfaces commit count and the
  cumulative branch diff (`base_commit → head_commit`). Reviewers cannot click
  individual commits to inspect a per-commit row diff. The data is already
  available through `GET /knowledge/contributions/:id/commits` and Dolt's commit
  graph; the UI work is deliberately deferred. Add this when a reviewer reports
  a real case where cumulative diff was insufficient. Do not build a DoltHub
  clone.

## Acceptance

The next implementation is done when:

1. An agent opens one contribution branch.
2. The same agent appends at least three commits to that branch.
3. At least one later commit updates a row created or visible on that branch.
4. A stale or parallel append cannot claim the same commit sequence.
5. `GET /diff` shows the cumulative Dolt row diff for review.
6. `GET /commits` shows the branch timeline.
7. The agent can close its own branch.
8. A session user can merge the branch to `main`.
9. Bearer merge is rejected.

## Implementation Status

PR #1343 now starts the workflow implementation: typed edit batches,
multi-commit contribution metadata, append/list commit endpoints, and
branch-local update/deprecate validation. The remaining gap is end-to-end
Doltgres stack coverage for create -> append three commits -> diff -> merge,
plus contributor-facing tooling that uses the append endpoint as the default
iteration path.
