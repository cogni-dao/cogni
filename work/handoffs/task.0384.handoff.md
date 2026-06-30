---
id: task.0384.handoff
type: handoff
work_item_id: task.0384
status: active
created: 2026-04-24
updated: 2026-04-24
branch: feat/vcs-flight-endpoint
last_commit: "218903946"
---

# Handoff: task.0370 — POST /api/v1/vcs/flight + vcs cleanup

## Context

- `POST /api/v1/vcs/pr` was merged to main (PR #1004) but was wrong — agents already have git push access and use `gh pr create` directly. It was removed.
- Replacement: `POST /api/v1/vcs/flight { prNumber }` — lets external agents programmatically request a candidate-a flight for a CI-green PR without going through the `pr-manager` LLM graph.
- The `vcs-create-branch` agent tool was also deleted in this branch — agents use native `gh`/`git` instead.
- Pre-push typecheck gate was busted by rebuilding `@cogni/ai-tools` (turbo cache bust exposed hidden implicit-any errors in all nodes' bootstrap capabilities). All fixed.
- Work item was renamed from `task.0361` to `task.0370` due to ID collision after a rebase.

## Current State

- PR #1021 is open, rebased on `main`, all checks green (pre-push `check:fast` passed)
- Branch: `feat/vcs-flight-endpoint` at commit `218903946`
- Work item status: `needs_merge`
- All acceptance criteria checked off in the work item
- `AGENTS.md` in `packages/ai-tools` cleaned of stale `vcs-create-branch` references

## Decisions Made

- No Postgres lease table — the deploy branch owns the lease (the per-`(env, node)` branch head IS the lease, `ci-cd.md` Axiom 18 `BRANCH_HEAD_IS_LEASE`); a parallel DB lease would create split-brain. See `docs/spec/ci-cd.md` Axiom 18 and the work item Design section.
- No post-dispatch GitHub run ID polling — GitHub returns 204 with no body. Agent observes the resulting check via `getCiStatus`. See [work item](../items/task.0370.vcs-flight-endpoint.md#approach).
- CI gate checks `allGreen && !pending` for the exact PR head SHA, not the base branch.
- `/.well-known/agent.json` now has `"flight"` key instead of `"contribute"`.

## Next Actions

- [ ] Review PR #1021: https://github.com/Cogni-DAO/cogni/pull/1021
- [ ] Merge to `main` (squash preferred per repo convention)
- [ ] Set `status: done` on `work/items/task.0370.vcs-flight-endpoint.md`
- [ ] Flight to `candidate-a` via `POST /api/v1/vcs/flight` on a CI-green PR (dogfood it)
- [ ] Verify Loki signal: `{namespace="cogni-candidate-a"} |= "vcs.flight" | json`
- [ ] Set `deploy_verified: true` in a PR comment (not frontmatter — see memory)

## Risks / Gotchas

- The `candidate-flight.yml` workflow requires GitHub App credentials that may not be configured in candidate-a yet — check `GITHUB_APP_*` env vars before testing dispatch.
- `dispatchCandidateFlight` returns `dispatched: true` even if the workflow has no available runner slot — the agent should poll `getCiStatus` to confirm the `candidate-flight` check appears on the PR head.
- Implicit-any errors in all 4 nodes' bootstrap capabilities were fixed in this branch (web-search, work-item, market, metrics, repo) — these were pre-existing but hidden by stale turbo cache. They are now in the diff.

## Pointers

| File / Resource                                                    | Why it matters                                                                     |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `work/items/task.0370.vcs-flight-endpoint.md`                      | Work item: full acceptance criteria + validation block                             |
| `nodes/operator/app/src/app/api/v1/vcs/flight/route.ts`            | New POST handler                                                                   |
| `packages/node-contracts/src/vcs.flight.v1.contract.ts`            | Zod contract for request/response                                                  |
| `packages/ai-tools/src/capabilities/vcs.ts`                        | `VcsCapability` interface (createBranch removed, dispatchCandidateFlight is there) |
| `nodes/operator/app/src/adapters/server/vcs/github-vcs.adapter.ts` | Real VCS adapter                                                                   |
| `docs/spec/agentic-contribution-loop.md`                           | As-built spec for the full agent contribution loop                                 |
| `docs/guides/agent-api-validation.md`                              | How to exercise API features after flight                                          |
| PR #1021                                                           | https://github.com/Cogni-DAO/cogni/pull/1021                                       |
