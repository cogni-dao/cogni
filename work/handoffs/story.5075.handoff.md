---
id: story.5075
type: handoff
work_item_id: story.5075
status: active
created: 2026-10-21
updated: 2026-10-21
branch: flock-leader/story-5075-integration
last_commit: 350ee923f0
---

# Handoff: Human–AI identity, permissions, attribution, and payout

## Mission

Pickup: own story.5075 as dev-manager and finish one cross-node identity standard without splitting human identity, AI identity, permission, authorship, or payout. PR #2784 is the sole operator integration and flight head; the source PRs remain review units only. No candidate flight is authorized yet.

## Goal

- Goal = Standardize human–AI identity, permissions, and attribution across every node.
- Done when = A human links an AI account, grants scoped access, the AI reads only authorized account data, its work remains AI-attributed, rewards reach the pinned human wallet, and operator, node-template, plus Poly prove the same contract live.
- Operator candidate proof must flight the exact approved PR #2784 head through `POST /api/v1/vcs/flight` with `workflowRef=flock-leader/story-5075-integration`; `https://test.cognidao.org/version` must report that exact `buildSha` before validation begins.
- `/validate-candidate` must prove both behavior and privacy-safe Loki terminals: bounded spawn; lost-response retry; rotate/confirm/recovery continuity; predecessor denial; direct and OBO allow/deny/revoke; direct three-party beneficiary acceptance; AI earner; signed atomic allocation; pending liability; exact-once settlement.
- Operator proof is not story completion. The final evidence bundle also needs a node-template conformance flight and a Poly authorized account read plus wrong-account, revoked, and foreign-principal denials using the same released contracts.

## Start By Reading

- [story.5075](https://cognidao.org/work/items/story.5075) — frozen goal, acceptance checklist, and original design ledger.
- [Integration PR #2784](https://github.com/cogni-dao/cogni/pull/2784) — only operator merge/flight head; read its current body and checks before acting.
- [Proposed identity canon + human visual](https://cognidao.org/knowledge/inbox/contrib-flock-leader-conductor-81425a7f) — open contribution, head `70nbfhtclb1f7avmuuqil50c9rigktrc`; human review is required before canon cutover.
- [Portable identity contract task.5291](https://cognidao.org/work/items/task.5291) — required no-split-brain package/release gate before node-template or Poly adoption.
- [Node BaaS model](https://cognidao.org/knowledge/node-baas-substrate-model), [identity keys](https://cognidao.org/knowledge/identity-keys-no-overload), [agent identity rule](https://cognidao.org/knowledge/agent-identity-not-human), and [attribution model](https://cognidao.org/knowledge/spawn-attribution-domain-model).
- [Identity research](../../docs/spec/decentralized-user-identity.md), [current legacy identity spec](../../docs/spec/identity-model.md), [RBAC](../../docs/spec/rbac.md), [attribution ledger](../../docs/spec/attribution-ledger.md), and [distribution lifecycle](../../docs/spec/tokenomics-distribution.md).
- [Dev-manager contract](../../.agents/skills/dev-manager/SKILL.md), [contributor contract](../../.agents/skills/contribute-to-cogni/SKILL.md), [observability finish pass](https://cognidao.org/knowledge/node-observability-finish-pass), and [candidate validation](../../.agents/skills/validate-candidate/SKILL.md).
- High-signal code: `packages/node-contracts/src/agent.identity.port.ts`, `packages/authorization-core/`, `nodes/operator/app/src/adapters/server/identity/agent-identity.adapter.ts`, `nodes/operator/app/src/app/_lib/auth/request-identity.ts`, `nodes/operator/app/src/app/_facades/work/items.server.ts`, `packages/db-client/src/adapters/drizzle-attribution.adapter.ts`, and `packages/attribution-pipeline-plugins/src/finalize/run-finalize-epoch.ts`.

## Current State

- Branch `flock-leader/story-5075-integration` is rebased onto main `7cc653675966795a32c263fb85a891be59bd0a0c`; reviewed code head is `350ee923f0352d1c19c55b3ae8c7997a8e748b45`. The durable handoff and formatter-only descendants do not change behavior; re-fetch the branch for its exact delivery head.
- Independent exact-head design/security review approves the code at `350ee923f0`: legacy and upgraded AI principals cannot enter human-only governance; P0/P1 writes deny before OpenFGA/store; ordinary durable-agent work preserves exact `agent:{node}/{actor}` authorship.
- Earlier P1s are closed: malformed OBO fails before transport; retired credentials and completed upgrades cannot replay secrets; lost upgrade responses recover only a bounded pending credential; beneficiary acceptance/revocation is participant-only; unknown beneficiary failures return sanitized 500s without raw-error logging; actor allocations are signed and persisted atomically; routes emit registered privacy-safe terminals.
- Exact-head CI and PR Build remain required. The first remote run on the reviewed code found one formatter-only miss in `node-admin-gates.route.test.ts`; repair it on the integration branch and rerun the complete checks. No local checks, tests, builds, installs, or dev servers were run because the CEO prohibited local resource use. No flight, merge, or promotion occurred.
- Source PRs #2654, #2666, #2672, #2676, #2749, #2663, #2665, and #2752 are review inputs, not independent flight heads. Do not spend time restacking or flighting them separately.
- The knowledge inbox is open with 9 commits and the updated human visual. It is proposed canon, not live canon. `docs/spec/identity-model.md` and `docs/spec/tokenomics-distribution.md` remain contradictory legacy sources until the contribution is human-merged and consumers are repointed.
- story.5075 is still held by an expired `flock-leader-operator` claim. The current agent key can read but cannot update it. This handoff, PR #2784, task.5291, and the knowledge inbox are the durable operational record until claim custody is repaired.
- Node-template PR #163 is draft/conflicting, 16 commits behind, and still projects fresh agents into `SessionUser`; replace it after task.5291 rather than salvaging its copied contract. Poly task.1791070995 has no implementation PR; its named branch is historical and zero commits ahead of Poly main.

## Design / Implementation Target

1. Keep `user_id` human-only and `actor_id` the durable local economic subject. An AI is `actor(kind=agent)` under its own node-qualified principal; credentials, billing accounts, wallets, bindings, and execution IDs never substitute for the actor.
2. The target node alone issues and verifies agent credentials. Spawn is authenticated, bounded, one-use, atomic, and idempotent. Rotation/recovery preserves actor, account, bindings, work ownership, and OpenFGA grants; retired or completed transitions never re-disclose secrets or restore revoked roles.
3. OpenFGA is the sole allow authority. Direct account reads require the exact agent→account relation; OBO requires the exact human→account, agent→human, and conditioned agent→account intersection. Local rows and RLS are defense in depth, never alternate allow sources.
4. Stewardship, permission, authorship, beneficiary, and wallet settlement are separate governed facts. Beneficiary activation needs direct beneficiary + AI earner + current steward acceptance; only those participants may revoke. Governance approver status alone grants no substitution or recovery power.
5. Freeze `earned_by_actor_id` and effective `beneficiary_actor_id` at the contribution cutoff inside the signed allocation set. Pin `claimant_wallet` later at cumulative materialization. Unresolved value is a fixed pending liability consumed exactly once; current identity or policy never rewrites signed history.
6. Complete task.5291 before downstream adoption: move the portable identity lifecycle declarations into dependency-clean public `@cogni/identity-core`, have private `node-contracts` re-export the single source temporarily, and add immutable attested release mechanics matching `authorization-core`. Nodes pin released artifacts; never copy schemas again.
7. Keep observability bounded: registered events, exactly one feature terminal per operation, stable low-cardinality codes, no credentials, identifiers, request bodies, raw errors, or secret-bearing stacks.

## Next Actions / Risks

- [ ] Watch all checks on exact head with `gh pr checks 2784 --watch --fail-fast`; finished is not green. Fix forward on the integration branch only.
- [ ] Fetch `origin/main` again. If main moved, integrate it and independently re-review conflict resolutions before treating prior approval or CI as current.
- [ ] Do not flight until the CEO explicitly authorizes it. When authorized, flight only PR #2784 through the operator API and the branch `workflowRef`; never dispatch GitHub directly and never flight a source PR.
- [ ] Run the full `/validate-candidate` scorecard only after `/version.buildSha` equals the exact PR head. Require real allow and deny behavior plus correlated feature-specific Loki evidence; a deployed SHA or denial-only probe is not proof.
- [ ] Ask the human to review/merge the exact knowledge inbox head. Verify both live entries and citations, then repoint story/spec consumers and thin legacy Markdown without creating dead links.
- [ ] Implement and release task.5291, then replace node-template #163 with one current-main conformance PR and flight it once.
- [ ] Open one fresh Poly PR from current Poly main; adopt the released identity/auth packages and prove authorized read plus wrong-account, revoked, foreign-principal, and exact-authorship behavior.
- [ ] Close source PRs as superseded only after the integration path is accepted; do not merge their divergent histories.
- Risk: main has moved repeatedly during this work. Exact SHA/base ancestry is a gate every time, not a one-time fact.
- Risk: PR #2784 changes candidate-flight workflow and OpenFGA activation; default-main workflow resolution can silently omit the code being tested.
- Risk: operator validation alone proves only the first vertical. Never mark story.5075 done until task.5291, node-template, Poly, knowledge cutover, and payout proof are live.
