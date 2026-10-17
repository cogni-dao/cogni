---
id: "story.5005-handoff"
type: handoff
work_item_id: "story.5005"
status: active
created: 2026-08-15
updated: 2026-08-15
branch: "fix/distribution-double-mint-stage1"
last_commit: "c2482c1e23"
---

# Handoff: distribution feature — PHASED rollout (we are EARLY, not near done)

## Mission

Pickup: own the token-distribution feature — contributors earn credits per epoch → claim real DAO tokens on Base (one-time scoped authorize, no per-epoch vote, double-mint-safe). **Read the framing first: this is a PHASED rollout and we are at the beginning.** The feature is NOT "the loop works on operator" — it is **"every node spawned from node-template can distribute."** toks2 proving the loop ≠ the feature proven: toks2 is the operator codebase in a costume. The feature is only proven when a **fresh node-template node** distributes (Phase 2, untouched).

## Goal

End state = the distribution loop lives on **operator (prod)** AND **node-template → all forks**, each proven on its OWN governance with a real epoch. E2E signal per node: owner signs an epoch → DAO mints the delta into the distributor + sets the root on Base → contributor claims; conservation holds; a re-publish is refused (409 + fold freeze). Candidate-a proof for Phase 1 = the standard `/validate-candidate` scorecard showing the build deploys + serves the distribution routes/pages + `/version` matches the flighted SHA (deploy-health, NOT the mint loop — candidate operator has no distributor).

## Start By Reading

- `docs/spec/tokenomics-distribution.md` — canonical mechanism (lifecycle, invariants, idempotency/replay, local-rig-vs-prod, operator↔node-template landing plan).
- PRs **#2020** (feature) + **#2021** (double-mint fix, stacked) + the validation scorecard on #2021.
- [node-test-contract](https://cognidao.org/knowledge/node-test-contract) (hub; the `test-expert` skill triggers it) § the walk harness (`pnpm test:walk:dev`).
- bug.5022 (double-mint — fixed by #2021) · bug.5023 (finalize queue-stealing — filed, Phase-1 blocker).
- Recall `cicd-e2e-required-sequence` before flighting — don't assert the flight payload from memory.

## Current State — Phase 0 done, that's all

- **PRs (stacked):** `#2020 toks2-e2e-rig → main` (feature R1–R4) · `#2021 fix/distribution-double-mint-stage1 → toks2-e2e-rig` (fix). **#2021's HEAD `c2482c1e` = the complete code.** #2020 alone is unsafe (no fix) — never ship it without #2021. Both CI-green.
- **Proven (Phase 0 — mechanism runs):** full loop sign→publish→claim on real Base (toks2 epoch 25, on-chain verified, conservation held) + double-mint closed at both layers (HTTP 409 proven A/B; fold-freeze unit passes). This proves the CODE RUNS. **Nothing about generality or the fleet.**
- **NOT proven:** operator's OWN distribution (operator has no distributor on Base) · node-template generality (a fresh node) · any fork.
- **Local rig live:** worktree `.claude/worktrees/agent-adf6ac46c826d893e`, freeze branch checked out, app+worker on toks2, `.env.cogni` symlinked, `pnpm test:walk:dev`.

## Phased Plan (the actual feature)

**PHASE 1 — SHIP OPERATOR (do now).** Pipeline: **candidate-a → merge → preview → prod** (candidate-a is the merge GATE).

1. Flight **#2021's HEAD** to candidate-a → `/validate-candidate`. Scope honestly: deploy-health only, NOT the mint loop. Say so in the scorecard.
2. Retarget **#2021 base → main**, merge it, **close #2020** (one clean merge of the whole thing). Derek approves every merge.
3. Promote **preview → prod**.
4. **Operator's OWN distribution setup on Base** — deploy operator's distributor + authorize (node-wizard flow, Derek's wallet). NEVER DONE. Verify operator's governance is operator's own (NOT toks2, NOT prod `0xF61c…`).
5. Real operator epoch → sign→publish→claim = first PRODUCTION distribution.

**PHASE 2 — NODE-TEMPLATE (the real generality proof; NOT started).**

- Port into the node-template repo: shared packages (cogni-contracts, aragon-osx, node-contracts, db-client, repo-spec), the scheduler-worker fold, and the per-node `/gov` UI (sign/publish/claim). **NOT** the operator-only node-wizard/gateway.
- Prove on a FRESH node spawned from node-template (its own DAO/token/distributor, its own epoch). **This is where the feature is actually proven.**

**PHASE 3 — FORKS (not started).** fork-sync to blue/habitat/poly; each proves its own per-node governance + setup.

## Next Actions / Risks

- [ ] Phase 1 step 1: flight #2021 HEAD → candidate-a → `/validate-candidate` (deploy-health scorecard).
- [ ] Phase 1 step 2–3: Derek-approved merge (#2021→main, close #2020) → promote preview → prod.
- [ ] **Before any real operator epoch: resolve bug.5023** — a wrong-scope worker steals finalize tasks off the shared `ledger-tasks` queue → "epoch not found" terminal fail + forced re-sign. Confirm prod isolates worker/queue per node.
- [ ] Phase 1 step 4: operator distributor setup on Base (Derek's wallet).
- 🔴 **RED LINE:** every node signs/publishes against its OWN throwaway/prod-appropriate governance — never toks2 in a prod path, never the prod DAO `0xF61c…` on a non-prod node.
- ⚠️ **candidate-a ≠ money proof** — it has no distributor; the mint loop is only ever proven per-node with a real setup.
- **Do NOT merge/promote/sign without Derek.** dev1 stepping back.
