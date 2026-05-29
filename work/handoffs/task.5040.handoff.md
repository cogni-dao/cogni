---
id: task.5040.handoff
type: handoff
work_item_id: task.5040
status: active
created: 2026-05-28
updated: 2026-05-28
branch: derekg1729/edo-citations-research
last_commit: 3dcc3477e
---

# Handoff: EDO Foundation Crawl tier (PR #1327) + adjacent migration-safety + multi-repo-sync work

## Context

- **PR #1327** delivers the **Crawl tier** of [`proj.edo-foundation`](../projects/proj.edo-foundation.md): schema (+evaluate*at, +resolution_strategy, +resolver-due index) on `knowledge`; `EdoCapability` + `EdoResolverPort` + Doltgres adapter; three atomic agent tools (`core\_\_edo*{hypothesize,decide,record_outcome}`); 352-line fake-adapter loop test. Spec lives in [docs/spec/knowledge-syntropy.md § The Hypothesis Loop](../../docs/spec/knowledge-syntropy.md#the-hypothesis-loop--event--hypothesis--decision--outcome).
- Three sibling PRs already shipped during this session: **#1347** (migration safety: immutability guard + verifier-as-gate + journal-walker migrator), **#1335** (`@cogni/node-template-knowledge` → `@cogni/knowledge-base` move), **#1358** (0004 repair migration for the ON CONFLICT incident, bug.5074). All on main + prod.
- The `needs-upstream-sync` chain is tracked in [task.5061](https://cognidao.org/work/items/task.5061) — schema + capability + tools must propagate to `cogni-poly` after these PRs land. PR **#1355** (multi-repo sync contract + manifest validator) makes that propagation declarative; until it lands, propagation is hand-rolled `git merge upstream/main` in poly.
- The first natural production EDO loop is the **poly copy-trade calibration pilot** (`pnl:<wallet>` resolution strategy reading `poly_trader_fills`). It blocks on (a) Crawl ship, (b) poly absorbing upstream, (c) Walk tier (resolver cron) landing. Filed conceptually in this conversation, not yet a work item.

## Current State

- **PR #1327 — head `3dcc3477e`, OPEN.** CI: required gates + sonar previously green on `72ed8435`; new `3dcc3477e` re-running. Flight on `72ed8435` reached candidate-a operator pod Ready (Loki shows `✓ schema verified against snapshot 0005_edo_columns (7 table(s))`) but the **resy verify-candidate job timed out at 5min** because resy crashlooped on `TOOL_BINDING_REQUIRED: Missing implementation binding for tool "core__edo_decide"`. Root cause: a prior trim removed the EDO stub bindings from resy + node-template to satisfy `single-node-scope`. Stubs are now restored on `3dcc3477e`.
- **`single-node-scope` will fail on the new commit.** The PR now spans operator + resy + node-template again. The mechanical catalog-binding fan-out is structurally different from the behavioral fan-out the policy was designed to catch, but extending the ride-along whitelist is a CI-wide policy decision Derek owns — **do not edit `.github/workflows/ci.yaml` or `tests/ci-invariants/classify.ts` without explicit user approval.**
- Spec change in this PR: added [§ "Read-Path Filters — Why EDO Doesn't Pollute knowledge"](../../docs/spec/knowledge-syntropy.md#read-path-filters--why-edo-doesnt-pollute-knowledge) + [§ "v0 Limitations + Walk-Tier Filters"](../../docs/spec/knowledge-syntropy.md#v0-limitations--walk-tier-filters). These document the read-path filter contract + two Walk-tier deliverables (default librarian filter + stale-hypothesis sweep) that close the user-visible "pollution" gap.
- Open follow-ups not yet filed as work items: (a) `LibrarianReadFilter` + Postgres partial index; (b) `staleHypothesisSweep` (auto-deprecate past `evaluate_at + 30d`); (c) `chore(ai): expose core__edo_* runtime EdoCapability on operator bootstrap` (replace the three stubs with `createEdoCapability(...)`); (d) Doltgres testcontainer EDO loop harness (real-adapter regression test against the four invariants).
- Other open business: **bug.5071** — operator fresh-deploy `BASE_DOMAIN_SEEDS` regression from #1347, scoped out; **PR #1355** — multi-repo sync contract, MERGEABLE but BLOCKED on review (no CI failures). Not in this branch's scope.

## Decisions Made

- Crawl tier ships the **write side** of EDO. Walk tier ships resolver cron + read-path filters + calibration view. See [proj.edo-foundation § Roadmap](../projects/proj.edo-foundation.md#roadmap).
- **No new tables for EDO.** Four beats are `entry_type` values on `knowledge`; recursion is emergent from `citations`. Per [knowledge-syntropy.md § Why No New Tables](../../docs/spec/knowledge-syntropy.md#why-no-new-tables). The user explicitly tested this decision in conversation; the spec section was extended to document the read-path filter answer to the "won't this pollute knowledge?" objection.
- Schema lives in `@cogni/knowledge-base/src/schema.ts` post-#1335. Forward-port from the orphaned `nodes/node-template/packages/knowledge/src/schema.ts` is part of commit `72ed8435`.
- Resy + node-template carry stub bindings (not runtime implementations) per the Crawl tier scope. Runtime `EdoCapability` wire-up on operator is a follow-up.
- Single-node-scope policy decision is **open + with Derek**. Do not touch CI policy files.

## Next Actions

- [ ] Watch CI on `3dcc3477e`. Required gates should re-pass (no behavioral change vs `72ed8435`; only stub bindings added). `single-node-scope` will fail.
- [ ] **Ask Derek** whether to (a) extend the ride-along whitelist in `.github/workflows/ci.yaml` line ~132 + `tests/ci-invariants/classify.ts` to permit catalog-class files like `**/bootstrap/ai/tool-bindings.ts`, (b) take an admin merge bypass on this PR, or (c) some other structural fix. **Do not act unilaterally.**
- [ ] After single-node-scope is resolved + sonar settles: re-flight via `POST /api/v1/vcs/flight {prNumber:1327}`. Validate via `/validate-candidate 1327`. The scorecard should look like the previous one ([comment 4568314441](https://github.com/Cogni-DAO/cogni/pull/1327#issuecomment-4568314441)) — 🟡 NOTES because EDO tools are stubs (UNPROVEN) but migration 0005 + verifier are PASS.
- [ ] After #1327 merges: file two Walk-tier tasks under `proj.edo-foundation` — `LibrarianReadFilter` (with the partial index in [the spec](../../docs/spec/knowledge-syntropy.md#read-path-filters--why-edo-doesnt-pollute-knowledge)) and `staleHypothesisSweep`. Then `chore(ai): expose core__edo_* runtime on operator` (replaces stubs with `createEdoCapability`). Then the poly copy-trade calibration pilot under `cogni-poly` (depends on `#1355` for declarative sync, or hand-merge upstream).
- [ ] Track upstream-sync state via [task.5061](https://cognidao.org/work/items/task.5061) — #1335, #1347, #1358, eventually #1327 all need to land in `cogni-poly`.

## Risks / Gotchas

- **Worktree hygiene:** the prior agent ran from `/Users/derek/conductor/workspaces/cogni-template/tehran` which is still checked out on the merged `derekg1729/doltgres-migration-safety` branch — never rebased to main. Session-start skill list is stale (no `knowledge-syntropy-expert`). **Start fresh from a worktree on `main` or use `chennai-v1` (this branch).** stuttgart-v1 has been confirmed to have the syntropy expert skill loaded.
- **Tool catalog enforces TOOL_BINDING_REQUIRED at boot.** Every node must bind every tool in `TOOL_CATALOG` — stubs are accepted, absence is fatal. This is why resy crashed; do not trim catalog bindings to make `single-node-scope` happy.
- **Operator API gates flight on `allGreen` across all checks, not just required.** A failing `single-node-scope` (or sonar) blocks `POST /api/v1/vcs/flight` even if the required gates are green.
- **Candidate-a slot is shared.** Don't re-flight just because it looks idle; check `gh run list --workflow=candidate-flight.yml` first.
- **Doltgres 0.56 ON CONFLICT is unreliable** (bug.5074 cause). The new migrator's `isHarmlessDropMiss` + `isAlreadyExists` patterns are the contract for idempotency in any future Doltgres migration. Do NOT use `ON CONFLICT (col, col) DO NOTHING` in `.sql` migration files.
- **`packages/knowledge-store/tests/edo-loop.test.ts`** is fake-adapter only. The real-Doltgres testcontainer harness for EDO doesn't exist yet — when filing the follow-up, model it on `nodes/operator/app/tests/component/db/doltgres-migrate.int.test.ts` from #1347.

## PR / Links

- PR #1327: https://github.com/Cogni-DAO/cogni/pull/1327
- Spec (this branch): [knowledge-syntropy.md § EDO Loop](../../docs/spec/knowledge-syntropy.md#the-hypothesis-loop--event--hypothesis--decision--outcome)
- Project: [proj.edo-foundation](../projects/proj.edo-foundation.md)
- Upstream-sync tracker: [task.5061](https://cognidao.org/work/items/task.5061)
- Fresh-deploy seed gap: [bug.5071](https://cognidao.org/work/items/bug.5071)
- Multi-repo sync contract PR: #1355
