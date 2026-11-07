# vcs · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

REST API routes for VCS operations — artifact-gated candidate-a flight dispatch for external AI agents.

## Pointers

- [Agentic Contribution Loop](../../../../../../../docs/spec/development-lifecycle.md)
- [VCS Integration Spec](../../../../../../../docs/spec/vcs-integration.md)
- [VCS Flight Contract](../../../../../../../../packages/node-contracts/src/vcs.flight.v1.contract.ts)
- [VCS Review Contract](../../../../../../../../packages/node-contracts/src/vcs.review.v1.contract.ts)

## Boundaries

```json
{
  "layer": "app",
  "may_import": ["bootstrap", "contracts", "shared", "ports", "features"],
  "must_not_import": ["adapters", "core"]
}
```

## Public Surface

- **Exports:** none (route handlers only)
- **Routes:**
  - `POST /api/v1/vcs/review` — developer-requested PR review (story.5102), the ONLY review trigger; `node.flight` on the named node; repo from `resolveNodeRepo`; pins the PR head; the requester is the run actor and payer; 202 `{workflowId, headSha, requestId}`, 409 `review_running` while the same head is under review, 409 `pr_not_open`, 422 `review_node_unsupported` for any node but the operator (v0)
  - `POST /api/v1/vcs/flight` — RBAC + artifact-gated candidate-a flight request for `nodeRef`; requires Bearer or session auth; checks `node.flight` when OpenFGA is configured; optional independent `workflowSha` + `workflowRef` is remote-only and additionally requires operator `node.flight`; 202 on dispatch, 422 if source/image preflight fails

## Ports

- **Uses ports:** `DeployPlanePort` (via operator-local factory)
- **Implements ports:** none

## Responsibilities

- This directory **does:** verify node flight authorization, verify nodeRef source/image preflight via `DeployPlanePort`, dispatch `candidate-flight.yml`, return dispatch metadata.
- This directory **does not:** own the slot lease (workflow owns it), poll for run ID, write any DB state.

## Standards

- All routes auth-protected (Bearer token or SIWE session required)
- OpenFGA-configured flight routes fail closed before GitHub prepare/dispatch unless `node.flight` allows the caller on the target node
- Input/output validated via `flightOperation` Zod contract
- Node references resolve through `features/nodes/node-lookup`; authorization and dispatch use the resolved UUID
- No direct Octokit — hosted deploy-plane calls go through `DeployPlanePort`

## Dependencies

- **Internal:** `@cogni/node-contracts` (flightOperation), `@/bootstrap/capabilities/operator-deploy-plane`, `@/shared/config/repoSpec.server`, `@/app/_lib/auth/session`
- **External:** next/server

## Change Protocol

- Update this file when **Routes** or deploy-plane port usage changes
- Update `vcs.flight.v1.contract.ts` first if request/response shape changes

## Notes

- Slot lease is owned by `candidate-flight.yml` workflow — not this route
- v0 single-tenant: `getGithubRepo()` returns the operator's own repo (task.0122 adds multi-tenant)
