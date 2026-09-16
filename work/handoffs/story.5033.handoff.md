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

- `story.5033` is priority 0, claimed by `flock-leader`, linked to draft PR #2267, and in `needs_implement`.
- Ordered children exist: `task.5123` actor registration + stewardship; `task.5124` earner/beneficiary attribution proof (blocked by 5123); `task.5125` principal migration + rotation + fleet sync (blocked by 5124).
- Commit `85d35508bc` aligns six identity/attribution/distribution/project documents. No runtime or schema code changed.
- As built, `/api/v1/agent/register` still creates a `users` row, billing account, and HMAC token whose `sub` is `user_id`; no actor table is shipped.
- Existing GitHub attestation can resolve `identity:github:<id>` to a human. That proves account control but collapses an AI earner into the human, so it is not the target model.
- Operator coordination briefly returned HTTP 500, then all operator `/version` and work/knowledge APIs returned HTTP 502. It recovered; the work graph was written and re-read successfully.
- `story.5021` and `task.5080` are now `needs_triage`, priority 3, blocked by `story.5033`; their independent slug/OpenFGA reliability bugs remain separate.
- No new knowledge branch was created: the shared `flock-leader` principal already owns two unrelated open contributions from other active work. Appending here would mix domains; creating a third would worsen branch sprawl.
- Draft PR #2267 is open; its current exact head is authoritative in GitHub and hosted CI is pending. No candidate flight occurred, and nothing is authorized to merge.

## Design / Implementation Target

1. Registration creates `actors(kind='agent')` plus a replaceable credential resolving to `agent:{actor_id}`; human users remain separate actors.
2. Stewardship is an evidenced two-party relationship: agent-authenticated request plus human-session acceptance. OpenFGA, `subjectId`, node ownership, billing, GitHub account control, and `parent_actor_id` do not imply it.
3. Attribution exposes immutable `earned_by_actor_id` and separately resolved `beneficiary_actor_id`; the agent benefits itself by default, historical claimant keys/statements never change, and a beneficiary freezes when a liability is materialized into a distribution leaf.

## Next Actions / Risks

- [ ] Keep the story heartbeat active while managing the children; `coordination.nextAction` is authoritative.
- [ ] Close or merge the existing `flock-leader` knowledge branches through their owning work, then contribute “Agent contribution stewardship separates earner from beneficiary” without mixing domains.
- [ ] Start `task.5123` in a dedicated implementation session. Before schema work, load `schema-update`, `database-expert`, `rbac-expert`, and `test-expert`; add append-only evidence and explicit migration for current user-backed agents.
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
