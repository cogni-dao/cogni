---
id: "story.5033-handoff"
type: handoff
work_item_id: "story.5033"
status: active
created: 2026-09-15
updated: 2026-09-15
branch: "derekg1729/story-5033-actor-attribution"
last_commit: "16da301a6a"
---

# Handoff: agent attribution and human ownership

## Mission

New mission: own the E2E identity → agent actor → contribution attribution →
human ownership path. For `flock-leader`, the AI must remain the recorded
earner while Derek can become its human parent and claim its economic benefit.

## Goal

- Registration creates a durable node-local agent actor; credentials may change
  without changing that actor.
- An agent and human establish the actor's parent relation through a two-party,
  audited flow; neither side can assign it alone.
- Candidate-a proves `flock-leader` as earner and Derek's human actor as the
  pinned beneficiary without changing historical claimant keys or statements.

## Start By Reading

- The merged Dolt knowledge entry for the approved actor-ownership protocol.
- `work/projects/proj.operator-plane.md` — existing actor hierarchy and reward
  rollup policy.
- `docs/spec/identity-model.md` — current identity primitives and runtime state.
- `docs/spec/attribution-ledger.md` — current signed allocation model.

## Current State

- `story.5033` is intake for the E2E outcome. `task.5128` owns draft PR #2267
  and the design decision; no runtime or schema implementation exists.
- Existing design already defines `earned_by_actor_id`,
  `beneficiary_actor_id`, parent-backed agent rollup, and immutable allocation-
  time beneficiary selection. Those concepts were not invented by this work.
- The unresolved gap is how a human safely becomes an agent's parent, how an
  external source identity is assigned to that agent, and how legacy unresolved
  allocations resolve once without mutating signed history.
- The current cumulative fold reads only the epoch being finalized. Despite its
  late-wallet comment, it has no backlog scan that can materialize an older
  unresolved allocation in a future root.
- Production knowledge/work APIs returned HTTP 502 during the latest pass, so
  the required merged/open-branch recall and Dolt contribution are pending.
- Hosted CI passed for the earlier docs-only head. No image was built, no
  candidate flight occurred, and no merge is authorized.

## Design / Implementation Target

1. Reuse the existing `parent_actor_id` ownership hierarchy and reward policy;
   do not invent a parallel stewardship relation.
2. Keep authorship, beneficiary, and wallet distinct. New actor-native
   allocations pin the beneficiary at allocation time; legacy unresolved
   allocations need a one-time append-only resolution path.
3. Materialize each resolved final allocation exactly once; every fold must
   scan the unresolved backlog rather than only the current epoch.
4. Prove the source assignment and human-parent claim with evidence and two
   authenticated parties; RBAC, billing, and display names prove neither.

## Next Actions / Risks

- [ ] Recall merged knowledge and this principal's open contribution diff.
- [ ] Refine an existing atom or contribute one atomic proposed protocol in
      Dolt; link it to `task.5128` through a `tracks` citation after merge.
- [ ] Reduce PR #2267 to the verified per-node `user_id` spec correction plus
      project/handoff routing; review the Dolt design before implementation.
- [ ] Only after design approval, implement `task.5123`, then `task.5124`, then
      `task.5125`, each as one PR with exact-head candidate validation.
- Risk: resolving beneficiary dynamically can redirect old rewards; pin it.
- Risk: binding `flock-leader` directly to a human erases the AI earner.

## Pointers

| File / Resource                                    | Why it matters                         |
| -------------------------------------------------- | -------------------------------------- |
| `work/projects/proj.operator-plane.md`             | Existing actor/reward north star       |
| `work/projects/proj.transparent-credit-payouts.md` | E2E ordering and work-item ownership   |
| `docs/spec/identity-model.md`                      | Current identity model                 |
| `task.5128`                                       | One-PR design and alignment owner      |
| `story.5033`                                      | Whole E2E outcome                      |
