---
id: "story.5033-handoff"
type: handoff
work_item_id: "story.5033"
status: active
created: 2026-09-15
updated: 2026-09-15
branch: "derekg1729/story-5033-actor-attribution"
last_commit: "85d35508bc"
---

# Handoff: agent attribution and human stewardship

## Mission

New mission: own the end-to-end identity → agent actor → contribution attribution → human stewardship domain. The concrete V0 is `flock-leader`: the AI remains the recorded earner, while Derek can establish an audited beneficiary relationship and claim its unresolved economic benefit without rewriting who authored the work.

## Goal

- A registered AI has a stable node-local `actor_id`; credentials rotate without changing it.
- The AI requests a one-time stewardship binding and an authenticated human accepts it; neither side can establish the relationship alone.
- Candidate-a proves `flock-leader` as earner and Derek as beneficiary across historical unresolved and new contributions, with signed statements unchanged and `/version.buildSha` equal to the flighted PR head.

## Start By Reading

- `docs/spec/identity-model.md` — current machine-as-user state, target actor registration, and stewardship decision.
- `docs/spec/attribution-ledger.md` — immutable authorship, explicit stewardship, and freeze-at-fold invariants.
- `docs/spec/decentralized-user-identity.md` — existing GitHub account-control claim; do not confuse it with agent stewardship.
- `docs/spec/tokenomics-distribution.md` — claimant wallet resolution and cumulative-fold boundary.
- `story.5033` on the operator — canonical E2E work item.

## Current State

- `story.5033` exists with the one-sentence outcome and priority 0.
- Commit `85d35508bc` aligns six identity/attribution/distribution/project documents. No runtime or schema code changed.
- As built, `/api/v1/agent/register` still creates a `users` row, billing account, and HMAC token whose `sub` is `user_id`; no actor table is shipped.
- Existing GitHub attestation can resolve `identity:github:<id>` to a human. That proves account control but collapses an AI earner into the human, so it is not the target model.
- Operator coordination returned HTTP 500, then all operator `/version` and work/knowledge APIs returned HTTP 502. The story claim, child task creation, story.5021/task.5080 reordering, and knowledge contribution are therefore not recorded.
- No PR exists, no candidate flight occurred, and nothing is authorized to merge.

## Design / Implementation Target

1. Registration creates `actors(kind='agent')` plus a replaceable credential resolving to `agent:{actor_id}`; human users remain separate actors.
2. Stewardship is an evidenced two-party relationship: agent-authenticated request plus human-session acceptance. OpenFGA, `subjectId`, node ownership, billing, GitHub account control, and `parent_actor_id` do not imply it.
3. Attribution exposes immutable `earned_by_actor_id` and separately resolved `beneficiary_actor_id`; the agent benefits itself by default, historical claimant keys/statements never change, and a beneficiary freezes when a liability is materialized into a distribution leaf.

## Next Actions / Risks

- [ ] Once the operator recovers, claim `story.5033`, heartbeat it, set branch, and move it to `needs_implement`.
- [ ] Create ordered child tasks: actor registration + stewardship foundation; actor claimant/read-model + `flock-leader` proof; existing-principal migration + credential rotation + fleet sync.
- [ ] Mark `story.5021` and `task.5080` as rotation work blocked by `story.5033`; keep their independent slug/OpenFGA reliability bugs separate.
- [ ] Open one operator knowledge contribution: “Agent contribution stewardship separates earner from beneficiary,” citing the existing epoch distribution guide.
- [ ] Before schema work, load `schema-update`, `database-expert`, `rbac-expert`, and `test-expert`; add append-only evidence and explicit migration for current user-backed agents.
- [ ] Prove the vertical slice on one node with real `flock-leader` history before fleet propagation or key rotation.
- [ ] Open a draft PR, let hosted CI run, flight the exact head once, run `/validate-candidate`, and only then permit merge.
- Risk: a dynamic beneficiary resolver could redirect already-folded liabilities; freeze the beneficiary at fold/materialization.
- Risk: migration must preserve existing OpenFGA node grants and GitHub/source bindings without treating the current fake user as a human.

## Pointers

| File / Resource                                    | Why it matters                                    |
| -------------------------------------------------- | ------------------------------------------------- |
| `docs/spec/identity-model.md`                      | Canonical identity and stewardship contract       |
| `docs/spec/attribution-ledger.md`                  | Earner/beneficiary and immutable-history rules    |
| `docs/spec/decentralized-user-identity.md`         | Existing human account-control path and its limit |
| `docs/spec/tokenomics-distribution.md`             | Settlement/fold boundary                          |
| `work/projects/proj.transparent-credit-payouts.md` | Roadmap and Pareto sequence                       |
| `story.5033`                                       | Canonical E2E work item                           |
