---
id: story.5070.handoff
type: handoff
work_item_id: story.5070
status: active
created: 2026-10-09
updated: 2026-10-09
branch: derekg1729/cognition-design
last_commit: 33ba85e0e9
---

# Handoff: fresh agents adhere to the agent-contract unprompted

## Mission

Pickup: you own closing the **adherence** gap in the cognition bootstrap. The end-to-end goal
is simple and behavioral — **a human spawns a fresh agent, and it responds in the agent-contract
(the status-contract block) with ZERO human prompting to do so.** Codex agents already do this
spectacularly, unprompted, on the current substrate. Claude Code agents, given the *identical*
bundle, still answer in prose and end on a "Want me to…? (y/n)" — a contract breach. Delivery
(getting the contract into context) is **solved and verified**; adherence (the agent actually
obeying it unprompted) is **not**, and that is the real work. Do not mistake delivery for the goal.

## Goal

- A fresh agent off `main`, given a work-shaped prompt containing **no** contract trigger words
  (no "agent-contract"/"status-contract"/"tldr"/"format"), replies as the status-contract block and
  **sustains** it the next turn — on Claude Code, Codex, and opencode.
- **E2E validation = the adherence eval passes.** Grade a fresh `claude -p` boot against
  `.claude/skills/cognition-expert/references/agent-contract-adherence.eval.md` (the Codex output is
  the gold standard; a Claude prose+y/n reply is the known-FAIL). PASS = the whole reply is the
  status-contract block, unprompted, no trailing bare y/n. Today: Codex ✅, **Claude ❌**, opencode ⏳.
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
- **Design PR open:** #2633 (`derekg1729/cognition-design`) — spec §Cognition Substrate refinement +
  `cognition-expert` skill + the adherence eval. Adversarially reviewed (NEEDS-WORK → corrected to the
  two-tier design). CI has intermittent main-drift on `unit`; rebase on `main` to clear, then merge.
- **The cache is NOT sprawl:** `.cogni/.cognition-cache.md` is gitignored (`.gitignore:127`), never
  committed, absent from a fresh clone. Git holds only the one-line `@import` pointer; the hub is source.
- **Open / blocked:** Claude adherence FAILS the eval. Propagation to node-template/fleet is **HALTED**
  by CEO until operator adherence is proven. Hub write-path is degraded (work-item `PATCH` → 500,
  knowledge `/contributions/{id}/commits` → 404); `vcs/merge` works. Operator key is `flock-leader-operator`
  (userId `f97e06f4-…`, RBAC developer+secrets_manager+production_promoter+env_manager granted).

## Design / Implementation Target

1. **Close Claude adherence** — the core open problem. Make a fresh Claude agent pass the eval. Candidate
   levers to test AGAINST the eval (don't guess — measure): more imperative contract framing in the
   Claude channel; whether the system-prompt tier vs project-instructions changes obedience; cutting
   competing low-signal injected context. It may expose a model-behavior limit — if so, document it.
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
   `opencode.json` are peripheral — deferred until adherence is proven. **No node-template/fleet
   propagation until a fresh operator Claude agent passes the eval.**

## Next Actions / Risks

- [ ] Rebase #2633 on `main`, confirm CI green, merge (design + skill + eval land on `main`).
- [ ] Run the adherence eval across contract-framing variants; find what makes a fresh `claude -p` PASS.
- [ ] Land the committed skeleton floor (req 2); then hook write-only (req 3).
- [ ] Only then: node-template parity + opencode.json + the orientation→map-only hub migration (human-merge-gated).
- Risk: **delivery ≠ adherence** — the trap this whole story fell into; grade with the eval, never assert.
- Risk: hub work-item `PATCH` 500s — can't update story.5070 outcome via API; state lives in the eval + `.context/story5070-resume.md`. File a bug when the write-path recovers.
- Risk: closing Claude adherence may be a model limit, not a substrate one (Codex passes the same bundle). If so, the deliverable is a documented finding + the eval, not a forced pass.

## Pointers

| File / Resource | Why it matters |
| --------------- | -------------- |
| `.claude/skills/cognition-expert/references/agent-contract-adherence.eval.md` | The frozen acceptance test (gold=Codex, fail=Claude). |
| `.claude/skills/cognition-expert/SKILL.md` | Mental model + cross-harness delivery matrix + gotchas. |
| `docs/spec/node-baas-architecture.md` §Cognition Substrate | The two-tier design of record. |
| `scripts/agent/session-cognition.sh` · `scripts/conductor-worktree-setup.sh` | Loader + the warm-at-setup step. |
| `nodes/operator/app/src/app/api/v1/cognition/_bundle.ts` | `SESSION_BOOTSTRAP_INVARIANTS`, render logic. |
| PRs #2626 (merged) · #2650 (merged) · #2633 (open) | Delivery, unconditional invariants, design. |
| `.context/story5070-resume.md` | Full drive log + findings. |
