---
id: proj.rbac-hardening
type: project
primary_charter:
title: RBAC Hardening — OpenFGA Authorization Implementation
state: Active
priority: 1
estimate: 4
summary: Implement OpenFGA-based authorization with actor/subject model, tool gating, and delegation management
outcome: All protected actions gated by AuthorizationPort.check() with dual-check for delegated execution
assignees: derekg1729
created: 2026-02-07
updated: 2026-06-08
labels: [authorization, rbac]
---

# RBAC Hardening — OpenFGA Authorization Implementation

> Source: docs/RBAC_SPEC.md (roadmap content extracted during docs migration)

## Goal

Implement the OpenFGA-based authorization system designed in the RBAC spec: AuthorizationPort with actor/subject dual-check, tool execution gating, connection broker gating, and audit events.

## Roadmap

### Crawl (P0) — RBAC Spine

**Goal:** Wire AuthorizationPort, OpenFGA adapter, context identity fields, subject binding, and enforcement points.

| Deliverable                                                                                | Status      | Est | Work Item |
| ------------------------------------------------------------------------------------------ | ----------- | --- | --------- |
| `AuthorizationPort` interface with dual-check logic                                        | In Review   | 2   | task.5010 |
| `OpenFgaAuthorizationAdapter` with timeout                                                 | In Review   | 2   | task.5010 |
| `FakeAuthorizationAdapter` for tests                                                       | In Review   | 1   | task.5010 |
| Context identity fields (actorId, subjectId?, tenantId, graphId)                           | In Review   | 1   | task.5010 |
| Subject binding enforcement (server-side only)                                             | Partial     | 1   | task.5010 |
| Wire into `toolRunner.exec()` (check before execution)                                     | In Review   | 2   | task.5010 |
| Wire into `ConnectionBroker.resolveForTool()` (check before token)                         | Not Started | 2   | —         |
| Pass actor + subject through entire call chain                                             | Partial     | 2   | task.5010 |
| Arch tests: authz-required-at-tool-exec, authz-required-at-broker, subject-binding-trusted | Partial     | 2   | task.5010 |
| Composition root wiring (container.ts)                                                     | In Review   | 1   | task.5010 |
| Observability + documentation chores                                                       | In Review   | 1   | task.5010 |
| Direct `POST /api/v1/vcs/flight` node RBAC gate                                            | In Review   | 1   | task.5010 |

**AuthorizationPort Interface:**

```typescript
interface AuthorizationPort {
  check(params: AuthzCheckParams): Promise<AuthzDecision>;
}
interface AuthzCheckParams {
  actorId: string; // "user:{user_id}" | "agent:{id}" | "service:{name}"
  subjectId?: string; // "user:{user_id}" — only for OBO execution
  action: AuthzAction; // "tool.execute" | "connection.use" | "graph.invoke"
  resource: string; // "tool:{id}" | "connection:{id}" | "graph:{id}"
  context: AuthzContext; // { tenantId, graphId?, runId? }
}
type AuthzDecision =
  | { decision: "allow"; code: "authz_allowed" }
  | { decision: "deny"; code: "authz_denied" | "authz_unavailable" };
```

**Context Identity Fields (`@cogni/ai-core/tooling/types.ts`):**

- [x] Add `actorId: string` to `ToolInvocationContext`
- [x] Add `subjectId?: string` to `ToolInvocationContext` (OBO only)
- [x] Add `tenantId: string` to `ToolInvocationContext`
- [x] Add `graphId?: string` to `ToolInvocationContext`
- [x] Pass direct-user graph context into `toolRunner.exec()`

**Subject Binding (per OBO_SUBJECT_MUST_BE_BOUND):**

- [x] `ToolInvocationContext.subjectId` is readonly, not from request body
- [ ] `subjectId` set ONLY at session/grant issuance (server-side)
- [ ] Arch test: grep for `subjectId` assignment outside trusted boundaries

**Env Vars:**

- [x] Add `OPENFGA_API_URL`, `OPENFGA_STORE_ID` to env validation
- [x] Configure OpenFGA store/model per environment through deploy-infra bootstrap

**File Pointers (P0 Scope):**

| File                                               | Change                                         |
| -------------------------------------------------- | ---------------------------------------------- |
| `packages/authorization-core/src/index.ts`         | `AuthorizationPort` with actor+subject         |
| `packages/authorization-core/src/adapters/*`       | OpenFGA adapter with dual-check + timeout      |
| `packages/authorization-core/src/test/*`           | Deterministic fake adapter                     |
| `packages/ai-core/src/tooling/types.ts`            | actorId, subjectId?, tenantId, graphId context |
| `packages/ai-core/src/tooling/tool-runner.ts`      | Inject AuthorizationPort, pass actor+subject   |
| `nodes/operator/app/src/bootstrap/container.ts`    | Wire authorization port                        |
| `nodes/operator/app/src/shared/env/server-env.ts`  | OPENFGA_API_URL, OPENFGA_STORE_ID              |
| `packages/ai-core/tests/tool-runner.authz.test.ts` | Authz bypass regression tests                  |

### Walk (P1) — Graph Invoke + Audit + Caching

**Goal:** Extend authorization to graph invocation, add audit events, caching.

| Deliverable                                                                      | Status      | Est | Work Item            |
| -------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Add `graph.invoke` check at `GraphExecutorPort.runGraph()` entry                 | Not Started | 2   | (create at P1 start) |
| Emit `authz.check` audit events with actor + subject                             | Not Started | 2   | (create at P1 start) |
| Add caching layer (LRU, 5s TTL, keyed by actor:subject:action:resource)          | Not Started | 2   | (create at P1 start) |
| Add batch check API for tool catalog filtering                                   | Not Started | 2   | (create at P1 start) |
| Implement scoped delegation via `delegation` type with `{tenant, graph}` binding | Not Started | 3   | (create at P1 start) |

### Run (P2+) — Delegation Management

**Goal:** User-facing delegation management with scoped, time-bounded delegations.

| Deliverable                                                    | Status      | Est | Work Item            |
| -------------------------------------------------------------- | ----------- | --- | -------------------- |
| UI for managing agent delegations                              | Not Started | 3   | (create at P2 start) |
| Delegation scopes (limit what agents can do on behalf of user) | Not Started | 2   | (create at P2 start) |
| Time-bounded delegations                                       | Not Started | 2   | (create at P2 start) |

**Condition:** Need agent management UI first.

## Constraints

- DENY_BY_DEFAULT: If no explicit relation exists in OpenFGA, check returns DENY
- OBO_SUBJECT_MUST_BE_BOUND: subjectId cannot be supplied by agents, tools, or request parameters
- AUTHZ_FAIL_CLOSED_WITH_DISTINCTION: deny on infrastructure failure, distinct error codes
- ToolPolicy and Grant Intersection are capability/safety gates that execute before OpenFGA (fail-fast)

## Dependencies

- [x] OpenFGA deployment/store bootstrap (Docker service + deterministic store/model bootstrap)
- [x] ToolPolicy design (TOOL_USE_SPEC.md)
- [x] ConnectionBroker design (TENANT_CONNECTIONS_SPEC.md)

## Next Protected Actions

| Protected action                                         | Phase | Status      | Notes                                                                                                                          |
| -------------------------------------------------------- | ----- | ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `core__vcs_flight_candidate` tool execution              | P0    | In Review   | Covered through `toolRunner.exec()` when OpenFGA is configured                                                                 |
| Direct `POST /api/v1/vcs/flight` dispatch                | P0.5  | In Review   | Checks `node.flight` on `node:{node_id}` before GitHub prepare/dispatch when OpenFGA is configured                             |
| Node developer request/approval tuple-write surface      | P0.6  | In Review   | Owner-gated `POST /api/v1/nodes/{node_id}/developers` materializes approval as `node:{node_id}#developer@user:{agent_user_id}` |
| `GraphExecutorPort.runGraph()` / `graph.invoke`          | P1    | Not Started | Blocks unauthorized graph start before model/tool loop                                                                         |
| `ConnectionBroker.resolveForTool()` / `connection.use`   | P1    | Not Started | Blocks token materialization before BYO provider credential release                                                            |
| Durable `authz.check` event + `authz.unavailable` metric | P1    | Not Started | Current adapter returns decision/check details; event/metric sink still needs composition-root integration                     |

## As-Built Specs

- [RBAC Spec](../../docs/spec/rbac.md) — Core invariants, actor model, OpenFGA schema, design decisions
- [Identity Model](../../docs/spec/identity-model.md) — Runtime `actorId`/`tenantId` distinction from DB identity keys
- [Authentication](../../docs/spec/authentication.md) — Browser session and HMAC bearer-token identity resolution
- [Browser Session Flight Auth](../../docs/guides/browser-session-flight-auth.md) — Creator/admin approval and bearer-token nodeRef flight procedure

## Design Notes

**P0 Known Limitation — Global Delegation:**

The current `user.delegates` relation is global—not scoped to tenant or graph. An agent with delegation can act on behalf of the user across all resources the user can access.

**P0 Mitigations:**

1. Only first-party agents (graphs defined in this repository) may receive delegation
2. MCP-discovered agents MUST NOT receive delegation (per MCP_UNTRUSTED_BY_DEFAULT)
3. Delegation issuance requires explicit user action in UI

**P1 Scope:** Implement scoped delegation via `delegation` type with `{tenant, graph}` binding.

**Chores (P0):**

- [ ] Observability [observability.md](../.agent/workflows/observability.md)
- [ ] Documentation [document.md](../.agent/workflows/document.md)
