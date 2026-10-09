---
id: story.5070.handoff
type: handoff
work_item_id: story.5070
status: active
created: 2026-10-09
updated: 2026-10-09
branch: derekg1729/cognition-design
last_commit: 58273bc06c
---

# Handoff: fresh agents adhere to the agent-contract unprompted

## Mission

Goal = Fresh agents follow the agent-contract unprompted

Done when = Fresh Claude, Codex, and opencode boots pass the sustained adherence eval.

Pickup: you own closing the **adherence** gap in the cognition bootstrap. The end-to-end goal
is simple and behavioral — **a human spawns a fresh agent, and it responds in the agent-contract
(the status-contract block) with ZERO human prompting to do so.** Fresh rich-bundle-only runs
showed that neither Claude nor raw Codex is reliably compliant: Claude mutated frozen state on
the follow-up; Codex wrapped the required table in prose. A temporary compact, literal floor made
both harnesses pass both turns. The repository change now encodes that floor and must reproduce
the result without temporary overrides. Do not mistake delivery or one-shot formatting for the goal.

## Goal

- A fresh agent off `main`, given a work-shaped prompt containing **no** contract trigger words
  (no "agent-contract"/"status-contract"/"tldr"/"format"), replies as the status-contract block and
  **sustains** it the next turn — on Claude Code, Codex, and opencode.
- **E2E validation = the adherence eval passes.** Grade a fresh `claude -p` boot against
  `.claude/skills/cognition-expert/references/agent-contract-adherence.eval.md` (the included output is
  the PASS shape; a prose/y-n reply is the historical known-FAIL). PASS = the whole reply is the
  status-contract block, unprompted, no trailing bare y/n, with frozen Goal and Done when. Current
  isolated compact-floor result: Claude ✅, Codex ✅. The committed repository floor is not yet
  rerun. OpenCode's only available local model is `llama3.2:3b`, which ignores the floor; a capable
  provider is not authenticated, so OpenCode acceptance remains unproven.
- This is a **client-side** change (loader + AGENTS.md + repo-committed floor), **not** a candidate-a
  deploy. There is no `/version` SHA proof to chase; the proof is a fresh-boot eval run. (The one
  server-side piece — the cognition endpoint — already shipped: operator prod serves the full bundle.)

## Start By Reading

- `.claude/skills/cognition-expert/SKILL.md` — the domain mental model + cross-harness delivery matrix (READ FIRST).
- `.claude/skills/cognition-expert/references/agent-contract-adherence.eval.md` — the frozen acceptance test + gold/fail examples.
- `docs/spec/node-baas-architecture.md` §Cognition Substrate — the two-tier design (code-owned skeleton floor + hub-refined rich contract; delivery via the file channel).
- `scripts/agent/session-cognition.sh` — the loader (fetch→write cache; per-runtime emit).
- `nodes/operator/app/src/app/api/v1/cognition/_bundle.ts` — `SESSION_BOOTSTRAP_INVARIANTS` + the (now-removed) ONE_VOICE suppression.
- `.context/story5070-resume.md` — the full 8-step drive log + findings.

## Current State

- **Delivery SHIPPED + verified on `main`:** `@import` of a gitignored, hook-fetched cache delivers the
  whole bundle to Claude Code (#2626, merged `1a0e206e`); invariants now render unconditionally so a
  map-only orientation can't drop the contract (#2650, merged `9af8d07a`). Verified: fresh clone of
  `main` → warm → `claude -p` returns the FULL contract and recited the stop-states.
- **PR #2633 rebased:** branch head `58273bc06c` is rebased on `origin/main` `4be3b7f268`.
  Static/analysis passed; build/component/unit failed only while pulling Docker Hub images (timeouts
  and HTTP 429), not from a branch test assertion. The compact floor + write-only hook are now being
  added on this branch and require fresh harness proof before merge.
- **The cache is NOT sprawl:** `.cogni/.cognition-cache.md` is gitignored (`.gitignore:127`), never
  committed, absent from a fresh clone. Git holds only the one-line `@import` pointer; the hub is source.
- **Open / blocked:** On 2026-10-09 a fresh Claude Code 2.1.293 boot at operator `main`
  `4be3b7f268` passed the two-turn format rubric without trigger words. Its follow-up changed
  the proposed `Done when`, revealing a gap between the frozen format eval and the full contract.
  Propagation to node-template/fleet remains **HALTED** until the stronger operator adherence proof
  passes. Hub write-path is degraded (work-item `PATCH` → 500,
  knowledge `/contributions/{id}/commits` → 404); `vcs/merge` works. Operator key is `flock-leader-operator`
  (userId `f97e06f4-…`, RBAC developer+secrets_manager+production_promoter+env_manager granted).

## Design / Implementation Target

1. **Close Claude adherence** — the frozen format eval now passes on a fresh operator `main` boot.
   Strengthen it with contract-state cases (frozen Goal/Done when, ownership gates, persistence) and
   test framing changes against those cases rather than claiming success from formatting alone.
2. **Committed skeleton floor** — a terse `SESSION_BOOTSTRAP_INVARIANTS` spine must render on a cold boot
   with NO network (hub-down / hosted / CI / claude.ai / raw clone), where the Conductor warm-setup
   doesn't run. The code-served invariants travel the authed endpoint, so they do NOT cover a cold boot;
   the floor must be in the committed repo (reaches all harnesses whole).
3. **Hook write-only (AFTER #2, coupled):** stop the Claude Code double-inject (loader emits
   `additionalContext` 2KB preview AND `@import` delivers). Make the Claude branch write-cache-only. Do
   this only after the skeleton floor lands — the 2KB preview is the current cold-boot scrap.
4. **Must NOT regress:** delivery on `main` (fresh-boot FULL), Codex adherence, the gitignored cache
   (never commit it), "replaces git-synced AGENTS.md sprawl" (git stays a pointer, hub stays source).
5. **Boundaries:** do NOT code-own the full rich contract (reintroduces the ONE_VOICE two-constitution
   duplication task.5155 killed + kills refine-in-place); the rich contract stays hub-refined. README /
   `opencode.json` are peripheral — deferred until adherence is proven. \*\*No node-template/fleet
   propagation until fresh operator Claude and Codex agents pass the committed-floor eval. OpenCode
   also needs a capable authenticated provider; V2 only discovers `AGENTS.md`, does not resolve
   configured `instructions` files, and does not expand the `@` cache reference.

## Next Actions / Risks

- [x] Rebase #2633 on `main`; classify the new CI failures as external Docker Hub pull failures.
- [x] Find a compact literal floor that passes two turns on fresh Claude and raw Codex variants.
- [ ] Validate the committed root floor + write-only hook with repository tests and fresh Claude/Codex boots.
- [ ] Authenticate a capable OpenCode provider and pass the same two-turn eval on OpenCode 1.14.20.
- [ ] Merge #2633 through the operator only after CI + three-harness acceptance; then consider fleet propagation.
- Risk: **delivery ≠ adherence** — the trap this whole story fell into; grade with the eval, never assert.
- Risk: story.5070's hub `PATCH` 500s — this is **bug.5418** (it predates the `created_by_principal_id` column; a NULL-creator row passes `mayMutate` authz then fails `validateTransitionMatrix`'s proof → 500 + orphaned branch). NOT a build regression. Fixed in `@cogni/work-items` 0.1.8 (node-template #160, being driven to all 6 nodes). Items created today `PATCH` fine. Persist story.5070's outcome once operator promotes 0.1.8 — do NOT file a churn item as a workaround. The knowledge `/contributions/{id}/commits` 404 was **bug.5085** (bearer must be the inbox's author principal; orphaned after this session's key rotation) + a cite-referencing-a-same-commit-row quirk — open a fresh inbox under the current key, insert and cite in separate commits. Until then, state lives in this handoff + `.context/story5070-resume.md`.
- Risk: local OpenCode proof currently measures `llama3.2:3b` capacity, not only substrate behavior;
  record runtime + model and do not claim the harness passes until a capable model does.

## Pointers

| File / Resource                                                               | Why it matters                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------- |
| `.claude/skills/cognition-expert/references/agent-contract-adherence.eval.md` | The frozen acceptance test (gold=Codex, fail=Claude).   |
| `.claude/skills/cognition-expert/SKILL.md`                                    | Mental model + cross-harness delivery matrix + gotchas. |
| `docs/spec/node-baas-architecture.md` §Cognition Substrate                    | The two-tier design of record.                          |
| `scripts/agent/session-cognition.sh` · `scripts/conductor-worktree-setup.sh`  | Loader + the warm-at-setup step.                        |
| `nodes/operator/app/src/app/api/v1/cognition/_bundle.ts`                      | `SESSION_BOOTSTRAP_INVARIANTS`, render logic.           |
| PRs #2626 (merged) · #2650 (merged) · #2633 (open)                            | Delivery, unconditional invariants, design.             |
| `.context/story5070-resume.md`                                                | Full drive log + findings.                              |
