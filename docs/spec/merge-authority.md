---
id: merge-authority
type: spec
title: Operator Merge Authority — One Chokepoint, Policy-Routed Authorization
status: draft
spec_state: proposed
trust: draft
summary: The cogni-operator app is the single authority that merges PRs across the network. All merges flow through one VcsCapability.mergePr chokepoint; a deterministic policy router authorizes per PR class (routine work-item, node-formation, governance override). GitHub re-enforces required checks at merge; the contributor never self-merges.
read_when: Designing or reviewing how PRs get merged, wiring the operator as merge authority, adding a merge-authorization class, or converging the duplicate merge paths.
implements: proj.development-workflows
owner: derekg1729
created: 2026-06-11
verified:
tags: [governance, merge, operator, lifecycle, vcs]
---

# Operator Merge Authority

> The cogni-operator app — the AI that runs the network's gitops — is the **single authority** that merges PRs. Every merge flows through **one** capability (`VcsCapability.mergePr`); a **deterministic policy router** decides _when_ a PR may merge based on its class. The contributing agent/human never self-merges its own work. GitHub Merge Queue still owns rebase/retest/serialization.

## Goal

> **North star:** the operator is the single, accountable merge authority for the whole network.

As the network grows, the operator runs its gitops deployments — and merging is the act with the most authority. Today that authority is fragmented across three disconnected paths and the merge _mechanics_ are duplicated. This spec converges them:

- **One merge chokepoint** — `VcsCapability.mergePr`. Every operator merge is auditable to one code path and one work-item session.
- **The operator is the merge authority** — not the contributor who wrote the PR (separation of duties), not a passive "green CI ⇒ GitHub rubber-stamp." The operator _decides_, on deterministic gates, and _acts_.
- **Authorization is deterministic, execution is a vendor primitive** — the merge decision is policy (gate booleans), never an LLM judgment, so the merge sequence stays auditable. GitHub re-enforces required checks at merge (and the merge queue, if re-enabled, owns rebase/retest).
- **One escape hatch with more authority, not less** — a PR that fails automated gates merges only through an on-chain DAO vote (the existing governance loop).

## Non-Goals

- **VM-capacity-aware placement** — modeling VM capacity, slotting nodes, provisioning VMs on demand. vNext; the node-formation class uses a flat count ceiling until then.
- **Building the attribution receipt** — `MERGE_EMITS_RECEIPT` is a non-blocking seam, not implemented here (see [attribution-ledger](./attribution-ledger.md), ~1 month out).
- **Replacing GitHub Merge Queue** — the queue still owns rebase/retest/serialization for routine + node-formation merges.
- **Removing the on-chain governance path** — the DAO vote stays as the higher-authority override for PRs that fail automated gates.
- **Multi-DAO / non-EVM governance** — one DAO per node deployment, per [dao-governance-loop](./dao-governance-loop.md) non-goals.

## The Problem Today (why this spec exists)

| Concern                 | As-built                                                                                                                                    | Drift                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Merge mechanics         | `GitHubVcsAdapter.mergePr` **and** governance `mergeChange()` both call `PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge` independently | duplicated; no single chokepoint                                       |
| Routine merge authority | contributor self-enqueues `gh pr merge --auto` (lifecycle step 8)                                                                           | effectively self-merge gated only by CI; operator is not the authority |
| Validation → merge link | none — `deploy_verified` is only a guidance string in `session-policy.ts`                                                                   | the gate the human cares about is not wired to merge                   |
| Node-formation merge    | none                                                                                                                                        | operator-authored node-wizard PRs (e.g. #1602) hang with no merger     |
| Governance override     | full DAO-vote → CogniSignal → `mergeChange` path ported                                                                                     | calls its own Octokit, not the capability; spec pointers stale         |

## Design

```
  AUTHORIZATION (deterministic policy router, operator-owned)        EXECUTION
  ──────────────────────────────────────────────────────────        ─────────
  routine work-item PR : CI.allGreen ∧ work_item.deploy_verified ─┐
  node-formation PR    : CI.allGreen ∧ deployedNodes < CEILING    ─┼─▶ VcsCapability.mergePr (PUT /merge)
  governance override  : re-verified on-chain CogniAction         ─┘   (the one chokepoint)
                                                                                 │
                                                       every merge bound to a work_item_sessions row (audit)
```

> **Execution reality (verified 2026-06-11):** `main` has `required_merge_queue: absent` and `enforce_admins: false`. So the operator **direct-merges** via `mergePr` (`PUT /pulls/{}/merge`); GitHub still enforces the 4 required status checks on the merge API, so a gate-passing `mergePr` is double-checked. There is no enqueue layer to build. `NO_AGENTIC_REBASE` holds trivially (no rebase happens). The one residual cost is stale-merge risk for the _routine_ class (no queue rebase-retest) → gate routine on require-up-to-date, or re-enable the queue, before scaling routine throughput. Node-formation is additive/non-racing, so direct-merge is safe; governance override relies on the App's `enforce_admins:false` bypass to merge a failed-check PR.

### Authorization classes

| Class                                                                    | Authority                            | Gate (all must hold)                                                                                                                         | Execution                      |
| ------------------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| **Routine** (work-item PR)                                               | operator                             | `CiStatusResult.allGreen` ∧ `work_item.deploy_verified == true` (`/validate-candidate` scorecard posted) ∧ authorizer ≠ claiming contributor | direct `mergePr` (gated)       |
| **Node-formation** (operator-authored `cogni-operator/node-submodule-*`) | operator                             | `allGreen` ∧ wizard-born node count `< CAPACITY_CEILING` (else comment + hand back)                                                          | direct `mergePr` (gated)       |
| **Governance override** (PR that failed automated gates)                 | DAO vote → CogniSignal `CogniAction` | on-chain re-verify (`ON_CHAIN_RE_VERIFY`, `CHAIN_DAO_MATCH`, `TX_HASH_DEDUP` — see [dao-governance-loop](./dao-governance-loop.md))          | direct merge (vote serializes) |

The node-formation capacity gate is the MVP capacity primitive: the operator has **no** awareness of VM capacity, where to slot a node, or when to create a VM. Until that exists (vNext), the ceiling is the config value `NODE_CAPACITY_CEILING` (env, default 8 — never a hardcoded literal), and the count is wizard-born submodule nodes (`nodes/<slug>` entries in the deployment parent's `.gitmodules`). At/over the ceiling the operator stops and hands back — the explicit boundary where compute planning must begin. The count comes from the deployment SSOT (`.gitmodules`), **not** the operator `nodes` table, because that table is RLS-scoped per owner in the web runtime and the `app_service` BYPASSRLS client is dependency-cruiser-banned in routes.

### Session binding

Every operator merge is auditable to a work-item session, reusing the `(repo_full_name, pr_number)` → active `work_item_sessions` lookup introduced for the flight chokepoint (PR #1317). Routine PRs already carry a session (the contributor claimed the work item). Node-formation PRs get an operator-owned session at mint time. A merge with no resolvable session is rejected (or flagged `unmediated`, matching the flight chokepoint's posture).

### Future alignment — attribution (do not build yet, do not contradict)

When the network becomes an AI-led company with contributor evaluations and credit payouts, operator merges and captured dev sessions feed the attribution ledger. This spec only commits to **not contradicting** that as-built model (see [attribution-ledger](./attribution-ledger.md)): a merge record must be expressible as an append-only, idempotent receipt keyed by `node_id` + canonical claimant (`user:<uuid>` or `identity:github:<id>`), with `scope_id` assigned at selection — never inline in the merge path. Dev-session capture (PR #1440 — `agent_transcript_chunks`) is the contributor record that pairs with it. `MERGE_EMITS_RECEIPT` is the seam; it is non-blocking and unbuilt.

## Invariants

| Rule                               | Constraint                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SINGLE_MERGE_CHOKEPOINT`          | Every operator merge goes through `VcsCapability.mergePr`. No feature issues `PUT /pulls/{}/merge` directly — governance `mergeChange()` must converge onto the capability.                                                                                                                                                                                                  |
| `OPERATOR_IS_MERGE_AUTHORITY`      | The operator (App identity) authorizes merges. The contributing agent/human never merges its own work-item PR.                                                                                                                                                                                                                                                               |
| `MERGE_SEPARATION_OF_DUTIES`       | The PR's requesting party is never its approver. For routine PRs that means authorizer ≠ claiming contributor (`work_item_sessions.claimed_by_user_id`). For node-formation the operator both authors and merges, so SoD means the **requesting node owner is excluded** and the gate is fully deterministic (CI = injection proof) — not distinct author/merger principals. |
| `ROUTINE_REQUIRES_DEPLOY_VERIFIED` | A work-item PR merges only when CI `allGreen` AND `work_item.deploy_verified == true`. (`DEPLOY_VERIFIED_SEPARATE` still holds: `done` = merged; `deploy_verified` = validated.)                                                                                                                                                                                             |
| `NODE_FORMATION_CAPACITY_GATE`     | An operator-authored node-formation PR merges only when CI `allGreen` AND wizard-born node count `< CAPACITY_CEILING`. At/over ceiling: comment + hand back, do not merge.                                                                                                                                                                                                   |
| `GOVERNANCE_OVERRIDE_ON_CHAIN`     | A PR that failed automated gates merges only via a re-verified on-chain `CogniAction` (`merge:change`).                                                                                                                                                                                                                                                                      |
| `DETERMINISTIC_AUTHORIZATION`      | Routine + node-formation merge decisions are deterministic policy (gate booleans), not LLM judgment. Preserves `NO_AGENTIC_REBASE`.                                                                                                                                                                                                                                          |
| `QUEUE_OWNS_SERIALIZATION`         | `main` has no enforced merge queue today (verified 2026-06-11), so the operator direct-merges via `mergePr` gated on `allGreen` (GitHub re-enforces required checks). No rebase happens, so `NO_AGENTIC_REBASE` holds. If the queue is re-enabled, the routine class switches to enqueue and the queue owns rebase/retest per `MERGE_QUEUE_DETERMINISM`.                     |
| `MERGE_BOUND_TO_SESSION`           | Every operator merge resolves to an active `work_item_sessions` row by `(repo_full_name, pr_number)`. Unresolvable → reject/flag `unmediated`.                                                                                                                                                                                                                               |
| `MERGE_EMITS_RECEIPT`              | (future, non-blocking) A merge emits an append-only, idempotent record keyed for attribution. Compatible with the ledger; never inline in the merge path.                                                                                                                                                                                                                    |

## Code Pointers — converge these (verified 2026-06-11)

**Merge capability (the chokepoint — keep, make canonical):**

- `packages/ai-tools/src/capabilities/vcs.ts` — `VcsCapability.mergePr({owner,repo,prNumber,method}) → MergeResult`; `getCiStatus(...) → CiStatusResult{ allGreen, pending, reviewDecision, labels, ... }`.
- `nodes/operator/app/src/adapters/server/vcs/github-vcs.adapter.ts` — `GitHubVcsAdapter.mergePr` → `PUT /pulls/{}/merge` (App-auth, per-repo installation token).
- `packages/ai-tools/src/tools/vcs-merge-pr.ts` — `core__vcs_merge_pr` tool.
- `nodes/operator/app/src/bootstrap/capabilities/vcs.ts` — factory (adapter on operator, stub elsewhere).

**Governance override (converge `mergeChange` onto the capability):**

- `nodes/operator/app/src/features/governance/actions.ts` — `mergeChange(signal, repoRef, octokit, log)`; action key `${action}:${target}` (= `merge:change`). Currently duplicates `PUT /pulls/{}/merge`.
- `nodes/operator/app/src/features/governance/signal-handler.ts` — `handleSignal(txHash, deps)` (RPC re-verify → decode → validate → execute).
- `nodes/operator/app/src/features/governance/signal-dispatch.ts` — `dispatchSignalExecution(payload, env, log)` (Alchemy webhook entry).
- `nodes/operator/app/src/app/api/internal/webhooks/[source]/route.ts` — webhook receiver (`github` + `alchemy`).

**Session binding (reuse — most functionally relevant):**

- `nodes/operator/app/src/features/work-item-sessions/session-policy.ts` — `nextActionForWorkItem(...)`; gates `/validate-candidate` before `/review-implementation` on `deploy_verified`.
- `nodes/operator/app/src/shared/db/work-item-sessions.ts` — `work_item_sessions` table.
- PR **#1317** (`derekg1729/op-flight-chokepoint`, open) — adds `repo_full_name` + `lookupActiveByPr({repoFullName, prNumber})` + the partial-unique `(repo_full_name, pr_number)` index + the `mediated`/`unmediated` flight posture. The merge authority extends this same binding from _flight_ to _merge_.
- `nodes/operator/app/src/app/api/v1/work/items/[id]/{claims,heartbeat,pr,coordination}/route.ts` — sessions REST.

**Contributor record (future attribution pair):**

- PR **#1440** (`derekg1729/claude-transcript-hook-to-operator`, open, conflicting) — `agent_transcript_chunks` (append-only, RLS+FORCE, principal-bound) + additive Langfuse dev-session view. The "developer session" record that pairs with `MERGE_EMITS_RECEIPT`.

**Merge-queue / branch protection (execution — unchanged):**

- `infra/github/branch-protection.json` — required checks `[unit, component, static, manifest]`; `required_pull_request_reviews: null`.
- `infra/github/merge-queue.json` — squash, `ALLGREEN`, `min_entries_to_merge: 1` (config payload; **not enforced on `main` today**).

**Prototype (as-built — this PR): node-formation capacity gate.**

- `nodes/operator/app/src/features/nodes/capacity.ts` — pure `countSubmoduleNodes(.gitmodules) → number` + `evaluateNodeCapacity({deployedNodeCount, ceiling}) → {allowed, reason}`. Unit-tested.
- `nodes/operator/app/src/shared/env/server-env.ts` — `NODE_CAPACITY_CEILING` (config, default 8).
- `nodes/operator/app/src/app/api/v1/nodes/[id]/publish/route.ts` — `check_capacity` step: reads the parent `.gitmodules` via `writer.fetchFileText`, evaluates the gate, returns `409 at_capacity` before minting consumes compute. (Enforced at publish — the cheapest point — rather than at merge; the merge step reuses the same primitive and is the next slice.)

## Acceptance Checks

E2E on candidate-a (test GitHub App on `cogni-test-org`, parent = the configured `NODE_SUBMODULE_PARENT_*`):

1. **Under capacity → birth proceeds.** With deployed `nodes/*` < `NODE_CAPACITY_CEILING`, `POST /api/v1/nodes/{id}/publish` returns 200 + opens the submodule PR (unchanged behavior). Loki: `event="node.publish.complete"` with `step="check_capacity"`, `outcome="success"`, `deployedNodeCount`, `ceiling`.
2. **At/over capacity → refused.** Set `NODE_CAPACITY_CEILING` below the current count (or mint up to it); `publish` returns **409** `{error:"network at node capacity", reason, deployedNodeCount, ceiling}` and mints nothing. Loki: `errorCode="at_capacity"`.
3. **Count correctness.** `deployedNodeCount` in the response/log equals the number of `nodes/<slug>` entries in the parent repo's `.gitmodules`.
4. **Config, not hardcoded.** Changing `NODE_CAPACITY_CEILING` in the candidate-a env and bouncing the pod changes the gate threshold with no code change.

## Open Questions

- [ ] Merge step (next slice): operator merges the node-formation PR after CI `allGreen` via `VcsCapability.mergePr` (reusing `evaluateNodeCapacity`) — explicit endpoint vs durable CI-green trigger (Temporal, mirrors `PrReviewWorkflow`).
- [ ] Governance `mergeChange` → `VcsCapability.mergePr` dedupe (`SINGLE_MERGE_CHOKEPOINT`) — safe refactor of the live on-chain path; sequence after the prototype lands.
- [ ] Where the policy router runs: a Temporal workflow (durable wait-for-CI-green, mirrors `PrReviewWorkflow`) vs an event-driven webhook handler. Must not depend on inbound-webhook delivery for the node-formation class.
- [ ] DB-backed `TX_HASH_DEDUP` for the governance override (currently in-memory — carried from dao-governance-loop Open Questions).

## Related

- [Development Lifecycle](./development-lifecycle.md) — work-item status machine; step 8 (merge) is owned by this spec's authority.
- [DAO Governance Loop](./dao-governance-loop.md) — the governance-override authorization class.
- [Attribution Ledger](./attribution-ledger.md) — the future receipt model `MERGE_EMITS_RECEIPT` must stay compatible with.
- [CI/CD](./ci-cd.md) · [Merge Queue Config](./merge-queue-config.md) · [Candidate Slot Controller](./candidate-slot-controller.md)
