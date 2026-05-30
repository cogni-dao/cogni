---
id: node-template-admin-route-group
type: handoff
work_item_id: node-template-admin-route-group
status: active
created: 2026-05-29
updated: 2026-05-29
branch: derekg1729/node-capacity-research
last_commit: 33ed5a4d9
---

# Handoff: node-template `(admin)/` route group + attribution-signer canonicalization

## Context

- Out of `/research` on node scaling + multi-tenancy, the research doc landed an `(admin)/` route group as the highest-priority 🔴 gap in the "current setup vs top 0.1% Next.js multi-tenant SaaS" scorecard.
- Derek then asked to add an `(admin)/` page in node-template and "port over" `packages/attribution-ledger/src/signing.ts` as the inaugural admin surface.
- On inspection: `@cogni/attribution-ledger` is **already** integrated into node-template (42 files). A fully-functional epoch-signer admin UI already exists at `(app)/gov/review/` (server-side approver gate via `_lib/approver-guard.ts`, client-side signing via `useSignEpoch`, all the EIP-712 typed-data plumbing). Module docblock literally calls it the "epoch review admin page" — it's just URL-misclassified under `(app)/gov/` rather than `(admin)/`.
- The real gap is structural URL semantics, not functionality. Three execution paths were proposed; **pending Derek's selection** before any code goes in.

## Current State

- **Branch `derekg1729/node-capacity-research`** holds one new commit (33ed5a4d9): the research doc `docs/research/node-scaling-multitenant-strategy.md`. Worktree clean.
- **No code changes started** for the `(admin)/` route group. Awaiting path selection (A/B/C below).
- **No work item created** in operator API (no `task.NNNN`). If proceeding, the contributor contract requires one; use slug `node-template-admin-route-group` or have the next agent file via `POST /api/v1/work/items`.
- **Side issue surfaced**: `.claude/skills/devops-expert/SKILL.md` "Current infra reality — 2026-05-18 post-split candidate-a" section is stale — claims Cogni monorepo has no candidate-a VM. Derek confirmed VM is live and flighting works. Needs a one-paragraph fix; not blocking but the misinformation will mislead future agents.

## Decisions Made

- Research doc landed: see `docs/research/node-scaling-multitenant-strategy.md` (commit 33ed5a4d9). Two classes of node: A = code-distinct (poly/resy/operator), keep per-node deploy; B = tenant-distinct ("shared-shell"/Dolt-only), build only when white-label demand arrives.
- Within each node-class: ONE Next.js + four route groups `(public)/(app)/(admin)/(infra)`. NOT three separate apps. Top-0.1% pattern reference: Vercel Platforms / Cal.com.
- Class B = "Dolt-only nodes" = tenant row + per-tenant Dolt schema + per-tenant agents via [`proj.agent-registry`](../projects/proj.agent-registry.md) + branding overlay. Designed; do not build until demand exists.
- `(admin)/` is the only 🔴 worth executing now (structural pattern lands once and is small).

## Next Actions

- [ ] **Confirm execution path with Derek** (A / B / C — see Risks for trade-offs).
- [ ] If **Path A (rename move)**: relocate `(app)/gov/review/` + `(app)/gov/epoch/` → `(admin)/gov/review/` + `(admin)/gov/epoch/`. Add `(admin)/layout.tsx` mirroring `(app)/layout.tsx`'s sidebar shell + a SERVER-side approver-set check (use `getLedgerApprovers()` from `@/shared/config`, similar pattern to `approver-guard.ts`). Grep + update all internal references to `/gov/review` and `/gov/epoch` (sidebar nav in `features/layout/`, breadcrumbs, redirect rules, AGENTS.md docs). Add `nodes/node-template/app/src/app/(admin)/AGENTS.md`. Update `(app)/AGENTS.md` route table.
- [ ] If **Path B (skeleton)**: add `(admin)/layout.tsx` + `(admin)/page.tsx` linking to existing `/gov/review`. Document `(admin)/` in AGENTS.md. Smallest-possible PR.
- [ ] If **Path C (no code)**: update research doc to flag the 🔴 `(admin)/` row as "already satisfied modulo URL semantics" + create a follow-up task to rename later. Push research doc PR alone.
- [ ] Create work item via `POST $BASE/api/v1/work/items` with `node: node-template`, type `task` (Path A/B) or `chore` (Path C). Claim + heartbeat per `/contribute-to-cogni` Phase 1.
- [ ] Push branch + `gh pr create --base main`. CI watcher (`gh pr checks --watch`) — Derek's `feedback_no_local_test_suites` says do not run test suites locally.
- [ ] After CI green: `POST /api/v1/vcs/flight { prNumber: N }` → `/validate-candidate` against `test.cognidao.org`. Candidate-a VM IS live (the devops-expert skill claim that it's missing is stale per Derek 2026-05-29).
- [ ] Fix stale devops-expert skill: edit `.claude/skills/devops-expert/SKILL.md` "Current infra reality — 2026-05-18 post-split candidate-a" paragraph to reflect that candidate-a is live. Can ride along Path A/B PR or land separately.

## Risks / Gotchas

- **`(app)/gov/review` rename blast radius (Path A)**: not just one move — nav menus in `features/layout/`, internal `<Link href=>` calls, possible `e2e/` Playwright specs hardcoding the URL, AGENTS.md path tables, and the `task.0119.epoch-signer-ui.md` historical reference. Grep for `gov/review` and `gov/epoch` repo-wide before committing.
- **Sync contract** (`.cogni/sync-manifest.yaml`): `nodes/node-template/*` is HUB content that syncs to the standalone `node-template` artifact repo. The move is substrate work and propagates naturally on next sync; no same-day porter needed. But: any new `(admin)/` pattern that lands here should be considered for parity port into `operator`, `resy`, `poly` — Derek runs a daily `sync-drift-detector.yml` workflow that will flag divergence.
- **Approver gate scope**: existing `_lib/approver-guard.ts` is for API routes (returns `NextResponse`). For `(admin)/layout.tsx` you need a page-shape gate — prefer server-side check (SIWE session → wallet → `getLedgerApprovers()` membership), client-side redirect on failure. Don't ship UI-only gating (the existing UI's `isApprover` prop is a UX hint, not security).
- **No formal work item yet**: `/contribute-to-cogni` Phase 1 requires claim+heartbeat+PR-link via the operator API. If next agent skips this, the work won't appear in `dolt_log` and the operator can't broadcast coordination. Don't skip.
- **Don't add a parallel signer**: the temptation under Path B is to wire a fresh `(admin)/attribution-signer/page.tsx` that re-uses `buildEIP712TypedData`. That builds a redundant UI next to the working one. The whole point of the discovery in this session was that the work is structural, not new logic. Resist parallel artifacts.

## Pointers

| File / Resource                                                                                     | Why it matters                                                                                                                |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `docs/research/node-scaling-multitenant-strategy.md` (commit 33ed5a4d9)                             | The research output. Read first — defines Class A/B + 4-route-group canonical shape + why `(admin)/` is the priority red gap. |
| `nodes/node-template/app/src/app/(app)/gov/review/page.tsx` + `view.tsx`                            | The existing admin-shaped signer UI that needs to move (Path A) or be referenced (Path B).                                    |
| `nodes/node-template/app/src/app/(app)/gov/epoch/page.tsx` + `view.tsx`                             | Sister page; same Path A move applies.                                                                                        |
| `nodes/node-template/app/src/app/(app)/layout.tsx`                                                  | Reference shell for `(admin)/layout.tsx` to mirror (sidebar + topbar).                                                        |
| `nodes/node-template/app/src/app/api/v1/attribution/_lib/approver-guard.ts`                         | The canonical approver-gate pattern. Adapt for page-level use in `(admin)/layout.tsx`.                                        |
| `nodes/node-template/app/src/app/api/v1/attribution/epochs/[id]/sign-data/route.ts`                 | Shows how `buildEIP712TypedData` is consumed server-side. Don't duplicate this in a parallel page.                            |
| `packages/attribution-ledger/src/signing.ts`                                                        | The signing primitive — already exported via `@cogni/attribution-ledger`. Do NOT "port" it; it's already wired.               |
| `nodes/node-template/app/src/features/governance/hooks/useSignEpoch.ts` (and sibling hooks)         | Existing client-side signing hooks. Reuse on any new admin pages; do not re-implement.                                        |
| `.cogni/repo-spec.yaml` → `activity_ledger.approvers`                                               | Where DAO-owner wallet list is declared. Resolved server-side via `getLedgerApprovers()` in `@/shared/config`.                |
| `nodes/node-template/app/src/app/AGENTS.md`                                                         | Route group conventions table; update on Path A/B to add `(admin)/`.                                                          |
| `work/projects/proj.agent-registry.md`                                                              | Tied to Class B; defines `AgentRegistrationDocument` + `AgentIdentityPort` (P0 in-flight). Read for Class B context only.     |
| `.claude/skills/contribute-to-cogni/SKILL.md`                                                       | Contributor contract. Phase 1 (claim/heartbeat/PR-link), Phase 2 (flight), Phase 3 (`/validate-candidate`), Phase 4 (merge).  |
| `.claude/skills/devops-expert/SKILL.md` "Current infra reality — 2026-05-18 post-split candidate-a" | STALE — candidate-a VM is live, flighting works (Derek confirmed 2026-05-29). Fix paragraph as side-quest.                    |
| `docs/spec/architecture.md` §"System Layers" + §"SSR-unsafe libraries"                              | Architecture invariants — `app` layer can't import adapters/core; wagmi SSR-cookie pattern is mandatory.                      |
| `task.0119.epoch-signer-ui.md` (referenced in `view.tsx` module docblock)                           | Historical context for why the existing signer UI exists and what it does.                                                    |
