---
id: temporal-patterns-spec
type: spec
title: Temporal Patterns
status: active
spec_state: draft
trust: draft
summary: Temporal workflow/activity patterns — determinism rules, LangGraph vs Temporal boundary, schedule configuration, anti-patterns, and infrastructure layout.
read_when: Writing Temporal workflows or activities, configuring schedules, or debugging replay issues.
owner: derekg1729
created: 2026-02-06
verified: 2026-04-28
tags: [ai-graphs, infra]
---

# Temporal Patterns

## Terminology

| Term             | Definition                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**     | A Temporal Workflow — the top-level durable execution unit. Deterministic, replay-safe.                                   |
| **Workflow run** | One Temporal execution of a Workflow, plus any optional app-side run record if the product chooses to persist one.        |
| **Graph**        | A LangGraph execution unit, typically invoked via `GraphRunWorkflow` and exposed as a workflow step in the product model. |
| **Graph run**    | A `GraphRunWorkflow` child execution + its `graph_runs` record. Drill-down detail of a parent.                            |
| **Activity**     | A Temporal Activity — all I/O lives here. Retryable, idempotent.                                                          |
| **Agent**        | An app-level `AgentDefinition` — a named configuration that selects a graph + model + tools.                              |
| **Tool**         | A callable capability exposed to graphs/agents (MCP tools, API calls, etc.).                                              |

Both Workflows and Graphs can be DAGs. The distinction is **durability and runtime semantics** — Temporal provides replay-safe durable execution with crash recovery; LangGraph provides in-process intelligence and dataflow. Neither term implies "AI" or "non-AI."

## Context

Cogni uses Temporal for durable workflow execution — governance signal collection, incident routing, agent orchestration, and user-scheduled graph runs. Temporal's replay-based execution model requires strict determinism in Workflow code, with all I/O isolated to Activities. This spec codifies the patterns and anti-patterns for safe Temporal usage.

## Goal

Ensure all Temporal workflows are replay-safe, Workflow code performs no I/O directly (all external interactions cross approved durable boundaries — typically Activities, sometimes child workflows such as `GraphRunWorkflow`), and schedules use consistent configuration patterns — so that deploys, restarts, and retries never break durable execution guarantees.

## Non-Goals

- Temporal infrastructure provisioning (covered by deployment/infra specs)
- Specific governance agent logic (covered by AI governance data spec)
- Scheduler CRUD API design (covered by scheduler spec)

## Core Invariants

1. **TEMPORAL_DETERMINISM**: No I/O, network calls, or LLM invocations inside Workflow code. All external calls (DB, LLM, APIs) run in Activities only. Violating this breaks replay on deploy/restart.

2. **ACTIVITY_IDEMPOTENCY**: All Activities must be idempotent. Temporal retries Activities on failure. Use idempotency keys for side effects derived from stable business keys. For **internal** side effects (DB upserts), `${workflowId}/${activityId}` is sufficient. For **externally visible** writes (GitHub comments, notifications), use business keys only (e.g., `${repo}/${pr}/${headSha}/${reviewType}`) — never include `attempt` in keys for external writes, as retries must produce the same external result.

3. **SCHEDULES_OVER_CRON**: Use Temporal Schedules for recurring work. Not cron jobs, not external schedulers. Schedules provide pause/resume, backfill, and operational visibility.

4. **WORKFLOW_ID_STABILITY**: Use stable, meaningful workflowIds derived from business keys (e.g., `scheduleId`, `incidentKey:timeBucket`). Enables idempotent workflow starts and prevents duplicates.

5. **SCHEDULED_TIME_FROM_TEMPORAL**: Activities derive `scheduledFor` from `TemporalScheduledStartTime` search attribute (authoritative source), never from workflow input or wall clock.

6. **OVERLAP_SKIP_DEFAULT**: Schedules use `overlap: 'SKIP'` by default. Only one workflow instance per schedule runs at a time.

7. **CATCHUP_WINDOW_ZERO**: P0 does not backfill missed runs. Set `catchupWindow: 0` to skip missed slots.

8. **CRUD_AUTHORITY**: Schedule lifecycle (create/update/pause/delete) is owned by CRUD endpoints, not workers. Workers only execute workflows fired by Temporal.

9. **WORKFLOW_TOP_LEVEL_VISIBILITY**: User/admin UI shows Workflow executions as the primary object. Graph runs are drill-down detail linked from Workflow steps. The dashboard's live view lists Workflow runs; expanding a run reveals its child graph run stream.

10. **SINGLE_INPUT_CONTRACT**: Each parent workflow's input shape is defined exactly once as a `.strict()` Zod schema in `packages/temporal-workflows/src/workflows/<name>.schema.ts`, consumed via `z.infer<typeof Schema>` at every call site. Producers parse with the schema before `workflowClient.start(...)`. Reference: `pr-review.schema.ts` (task.0419).

## Design

### Workflow Boundaries

**What Goes in Workflows (Deterministic):**

- Conditionals and loops over workflow state
- Calling Activities and child Workflows
- Waiting for signals and timers
- State machine transitions
- Parsing Activity results (deterministic transforms)

**What Goes in Activities (I/O):**

- Database reads and writes
- HTTP/API calls
- LLM invocations (via GraphExecutorPort)
- File system operations
- External service calls (MCP, webhooks)
- Metrics emission

### Common Patterns

#### 1. Scheduled Collection Workflow

```typescript
// Workflow: deterministic orchestration only
export async function CollectSourceStreamWorkflow(
  source: string,
  streamId: string
): Promise<void> {
  // Activity: load cursor from DB
  const cursor = await loadCursorActivity(source, streamId);

  // Activity: collect signals (I/O to external system)
  const { events, nextCursor } = await collectSignalsActivity(
    source,
    streamId,
    cursor
  );

  // Activity: ingest signals (DB write)
  await ingestSignalsActivity(events);

  // Activity: save cursor (DB write)
  await saveCursorActivity(source, streamId, nextCursor);
}
```

#### 2. Incident-Gated Agent Workflow

```typescript
// Triggered by incident lifecycle event, not timer
export async function GovernanceAgentWorkflow(
  incidentId: string,
  eventType: IncidentLifecycleEvent["type"]
): Promise<void> {
  // Activity: check cooldown
  const shouldRun = await checkCooldownActivity(incidentId, COOLDOWN_MINUTES);
  if (!shouldRun) return;

  // Activity: generate brief (DB read + aggregation)
  const brief = await generateBriefActivity(incidentId);

  // Activity: run LLM agent (via GraphExecutorPort)
  const result = await runGovernanceGraphActivity(brief);

  // Workflow: deterministic decision based on result
  if (result.hasRecommendation) {
    // Activity: write EDO record
    await appendEdoActivity(result.edo);
    // Activity: create work item via MCP
    await createWorkItemActivity(result.workItem);
  }

  // Activity: mark incident as briefed
  await markBriefedActivity(incidentId);
}
```

#### 3. Router with Fast-Path Kick

```typescript
// IncidentRouterWorkflow: can be started by schedule OR webhook fast-path
// workflowId = `router:${scope}:${timeBucket}` for idempotency
export async function IncidentRouterWorkflow(scope: string): Promise<void> {
  // Activity: query recent signals
  const signals = await querySignalsActivity(scope);

  // Activity: query metrics for threshold checks
  const metrics = await queryMetricsActivity(scope);

  // Workflow: deterministic threshold evaluation (NO I/O)
  const incidents = evaluateThresholds(signals, metrics);

  for (const incident of incidents) {
    // Activity: upsert incident, get lifecycle event
    const event = await upsertIncidentActivity(incident);

    // Workflow: if lifecycle event, start child workflow
    if (event) {
      await startChild(GovernanceAgentWorkflow, {
        args: [incident.id, event.type],
        workflowId: `agent:${incident.id}:${event.type}`,
      });
    }
  }
}
```

### Schedule Configuration

#### Standard Schedule Setup

```typescript
await temporalClient.schedule.create({
  scheduleId: dbRecord.id, // Use DB ID for correlation
  spec: {
    cronExpressions: [cronExpression],
    timezone: "UTC",
  },
  action: {
    type: "startWorkflow",
    workflowType: "CollectSourceStreamWorkflow",
    workflowId: dbRecord.id, // workflowId = scheduleId
    args: [source, streamId],
    taskQueue: "governance-tasks",
  },
  policies: {
    overlap: ScheduleOverlapPolicy.SKIP,
    catchupWindow: "0s", // No backfill in P0
  },
});
```

#### CRUD Authority

| Operation    | Authority           | Worker Role   |
| ------------ | ------------------- | ------------- |
| Create       | `POST /schedules`   | None          |
| Update/Pause | `PATCH /schedules`  | None          |
| Delete       | `DELETE /schedules` | None          |
| Execute      | Temporal fires      | Runs workflow |
| Reconcile    | Admin CLI only      | None          |

### Pipeline Stage Composition

Complex workflows (e.g., epoch collection) decompose into **typed child workflows** representing pipeline stages. Each stage has explicit I/O types, is independently retryable, and appears as a separate workflow in the Temporal UI.

**Convention:**

- Stage workflows live in `workflows/stages/` and are exported from the barrel file
- Stage I/O types live in `workflows/stage-types.ts` — plain serializable objects only
- Activity proxy configs live in `workflows/activity-profiles.ts` — shared across all workflows
- Parent workflows compose stages via `executeChild()` with stable workflowIds
- Use `patched()` to gate structural changes for in-flight replay safety

```typescript
// Parent workflow: thin orchestrator
export async function CollectEpochWorkflow(raw: ScheduleActionPayload) {
  // Setup activities (inline — cheap, always needed)
  const epoch = await ensureEpochForWindow({ ... });
  if (epoch.status !== "open") return;

  // Stage 1: collect from all sources (child workflow)
  await executeChild(CollectSourcesWorkflow, {
    args: [{ epochId: epoch.epochId, sources, periodStart, periodEnd }],
    workflowId: `collect-sources-${epoch.epochId}`,
  });

  // Stage 2: enrich and allocate (child workflow)
  await executeChild(EnrichAndAllocateWorkflow, {
    args: [{ epochId: epoch.epochId, attributionPipeline, weightConfig }],
    workflowId: `enrich-allocate-${epoch.epochId}`,
  });

  // Terminal: pool + auto-close (inline — conditional, simple)
  // ...
}
```

**Shared activity proxy configs** eliminate retry/timeout duplication:

```typescript
// workflows/activity-profiles.ts
import type { ActivityOptions } from "@temporalio/workflow";

export const STANDARD_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "2 minutes",
  retry: {
    initialInterval: "2s",
    maximumInterval: "1m",
    backoffCoefficient: 2,
    maximumAttempts: 5,
  },
};

export const EXTERNAL_API_ACTIVITY_OPTIONS: ActivityOptions = {
  startToCloseTimeout: "5 minutes",
  retry: {
    initialInterval: "5s",
    maximumInterval: "2m",
    backoffCoefficient: 2,
    maximumAttempts: 3,
  },
};
```

### Node-as-tenant (declarative node schedules)

> **As-built vs target — CREATE differs by tenant (task.5035).** The **execution**
> substrate below is generic and shipped (`NodeTaskWorkflow` / `GraphRunWorkflow`,
> grant↔node binding, the per-node dispatch principal, the per-node queue). What differs
> is who **creates** the schedule:
>
> - **System tenant (operator — governance / epochs):** declares schedules in its own
>   repo-spec; the operator reconciles them via `syncGovernanceSchedules`. **This is wired
>   and live — repo-spec-defined workflows for the system tenant stay 100% supported**, and
>   epochs run on exactly this path.
> - **Node tenants (recurring work):** the going-forward CREATE is **node-direct** — the
>   node's own Temporal client, operator out of the create path — per
>   [substrate-temporal.md](./substrate-temporal.md). The `syncNodeSchedules` reconcile
>   path below is **built but unwired** (no production caller today); it is retained as the
>   execution-contract reference and the same reconcile capability the system tenant uses,
>   not as the node create default.

The generic execution substrate runs a node's recurring work under _that node's_ tenant
identity. The node writes **zero** Temporal code; the shared worker adds **zero** per-node
code. This generalizes the graph-schedule path (which already works end-to-end) to
non-graph HTTP-dispatch via one generic workflow.

```yaml
# .cogni/repo-spec.yaml — the node-author-facing contract
schedules:
  - id: metrics-ingest # stable → scheduleId + workflowId
    cron: "*/15 * * * *"
    timezone: UTC
    route: /api/internal/ops/metrics-ingest # relative path on the node's OWN host
    payload: { window: "15m" }
```

#### The reconcile + dispatch flow

The **dispatch/execution** half (`NodeTaskWorkflow` → validate-grant → dispatch) is the
shipped, tenant-agnostic substrate. The `syncNodeSchedules` **create/reconcile** half is
built but **unwired** for node tenants — node-direct create supersedes it as the default
(see the banner above) — while the system tenant's equivalent (`syncGovernanceSchedules`)
is wired and live.

```
syncNodeSchedules (SYSTEM_OPS_ONLY, advisory-locked, @cogni/scheduler-core)
  → ensure per-node ExecutionGrant (scope: task:dispatch:<route> | graph:execute:<id>)
  → upsert DB row (stores the cron — the SSOT for drift; Temporal can't read it back)
  → ScheduleControlPort.create/update/pause/resume
       scheduleId = workflowId = node-task:{nodeId}:{scheduleId}   (WORKFLOW_ID_STABILITY)
       overlap=SKIP, catchupWindow=0s                              (operator-fixed)
       route → NodeTaskWorkflow   |   graph → GraphRunWorkflow      (workflowType inferred)

NodeTaskWorkflow(input: NodeTaskInput)                              (the generic non-graph workflow)
  scheduledFor = TemporalScheduledStartTime search attr            (SCHEDULED_TIME_FROM_TEMPORAL)
  → validateGrantActivity(actor, nodeId, grantId, "task:dispatch:<route>")
  → dispatchNodeTaskActivity: POST {nodeUrl}{route}, principal = per-node token (fail-closed)
       Idempotency-Key: {nodeId}/{scheduleId}/{scheduledFor}       (the node route MUST dedup on it)
```

#### Invariants specific to node-as-tenant

| Invariant                             | Rule                                                                                                                                                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WORKFLOWTYPE_FROM_ROUTE_XOR_GRAPH** | The node declares `route` XOR `graph`; the workflowType is _inferred_ from which is present. There is no node-facing `target` enum — that is operator vocabulary.                                                                            |
| **PLATFORM_OVERLAP_AND_CATCHUP**      | `overlap`/`catchupWindow` are NOT in the node-facing schema. The operator fixes `skip`/`0s`; a node cannot tune them.                                                                                                                        |
| **REAL_CRON_DRIFT**                   | Cron drift is detected against the **stored cron** (DB row), never `describeSchedule().cron` — Temporal compiles crons to calendars and returns null. (The governance equivalent skips cron entirely; that is a latent bug this path fixes.) |
| **NODE_ID_PINNED (M8)**               | A schedule's `nodeId` is pinned to the repo-spec's own `node_id`; a repo-spec cannot author a foreign-node schedule. `route` is relative to the node's own host (SSRF / cross-tenant guard).                                                 |
| **TENANT_PRINCIPAL_FAIL_CLOSED**      | Dispatch uses a per-node principal resolved at runtime; an unprovisioned node throws — there is no shared-token fallback.                                                                                                                    |
| **TEARDOWN_REVOKES (M7)**             | Node decommission pauses the node's schedules **and** `revokedAt`s its grants in one saga; validation fails closed on revoked grants.                                                                                                        |

#### Idempotency is a two-sided contract

The operator forwards `Idempotency-Key: {nodeId}/{scheduleId}/{scheduledFor}`; the node's
route **must** dedup on it. A key the receiver ignores does not make a POST idempotent. The
MVP retry profile is `maximumAttempts: 1` precisely because the dedup contract is the node's
responsibility — a retry profile is gated on that contract being proven.

> **Ownership:** the `NodeTaskInput` schema and `NodeTaskWorkflow` / `dispatchNodeTaskActivity`
> live in `packages/temporal-workflows` (SINGLE_INPUT_CONTRACT, owned by the workflow-bundle
> work). The repo-spec `schedules` block + `syncNodeSchedules` + teardown live in
> `@cogni/repo-spec` and `@cogni/scheduler-core`. See
> [substrate-temporal.md](./substrate-temporal.md) for the node-direct create model (it
> supersedes the operator-dispatch framing in the now-retired
> node-temporal-tenant-interface.md).

### LangGraph vs Temporal Boundary

The boundary between LangGraph and Temporal is **durability and runtime semantics**, not DAG shape or AI-vs-non-AI. Both systems can express DAGs; the question is whether a step needs crash recovery, idempotency, and cross-process coordination (Temporal) or in-process intelligence and dataflow (LangGraph).

#### LangGraph owns: in-run intelligence and dataflow

- LLM calls, tool usage, nested graphs, branching
- Retries local to the reasoning loop
- State transforms, recomputable read-side API fetches
- Anything safely recomputable — graph loss = re-run, not data loss

#### Temporal owns: durable orchestration boundaries

- Webhook/schedule/user triggers (entry points)
- Long waits, cross-step coordination, human approval
- Idempotency keys, resume-after-crash
- Externally visible writes that must not be lost or duplicated

#### Rule of thumb

| Step type                                     | Owner     |
| --------------------------------------------- | --------- |
| Thinking, evaluating, gathering               | LangGraph |
| Committing, notifying, mutating, coordinating | Temporal  |

**Hard rule:** Reads may live in graphs. Writes that matter live behind Temporal unless explicitly best-effort and disposable. Treating every external read/write as a Temporal concern is over-engineering — graphs may do recomputable reads and tooling, but material writes must cross a Temporal-owned durable boundary.

#### Normative Pattern: Webhook → Parent Workflow → Graph Child → Write Activity

All webhook-triggered graph execution **must** follow this pattern. It is the canonical template for PR review, deploy analysis, incident response, and any future webhook→graph flow.

```
webhook route (fire-and-forget)
  → start ParentWorkflow (Temporal parent — exits immediately)
    → Activity: fetch context (read — Temporal gives retry + timeout)
    → executeChild: GraphRunWorkflow(graph-id) (LangGraph decision)
      → graph returns structured decision artifact (pure data, no side effects)
    → Activity: write result (durable write — idempotent via business key)
```

**Required constraints:**

1. Webhook handler starts the Workflow and exits immediately — no blocking Next.js on Redis/SSE for completion
2. Graph returns a **pure structured decision artifact**, not side effects. Required writes happen in Activities after the graph child completes
3. Write Activities use idempotency keys derived from **stable business keys** (e.g., `${repo}/${pr}/${headSha}/${reviewType}`). Do not include `attempt` in idempotency keys for externally visible writes — retries must produce the same external result
4. `graph_runs` records the child GraphRunWorkflow for dashboard observability (per WORKFLOW_TOP_LEVEL_VISIBILITY, the parent Workflow is the primary UI object; the graph run is drill-down detail)
5. Retries on write Activities do not double-post

#### Anti-pattern: inline graph execution in HTTP handlers

```typescript
// BAD: webhook handler runs graph inline, posts comment inline
const result = executor.runGraph({ graphId: "pr-review", ... });
for await (const _event of result.stream) { /* drain */ }
await postComment(result); // no idempotency, no crash recovery
```

This violates ONE_RUN_EXECUTION_PATH. The graph run is invisible to the dashboard, has no `graph_runs` record, and the write has no crash recovery or idempotency.

### Anti-Patterns

| Anti-Pattern                                                            | Why Forbidden                                                                   |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| I/O in Workflow code                                                    | Breaks Temporal replay; all I/O must be in Activities                           |
| LLM calls in Workflow code                                              | Non-deterministic; LLM must run in Activities only                              |
| `Date.now()` in Workflow                                                | Non-deterministic; use `workflow.now()` or Activity                             |
| Random/UUID in Workflow                                                 | Non-deterministic; generate in Activity or pass as input                        |
| Worker modifies schedules                                               | CRUD endpoints are single authority                                             |
| Always-on reconciliation                                                | Creates authority split; use admin CLI                                          |
| Wall clock for scheduledFor                                             | Use `TemporalScheduledStartTime` search attribute                               |
| Inline `executor.runGraph()` in webhook/HTTP handlers for required work | Violates ONE_RUN_EXECUTION_PATH; invisible to dashboard, no crash recovery      |
| `attempt` in idempotency keys for external writes                       | Retries must produce same external result; use stable business keys only        |
| Vendor terminology (`assistant`) as core internal nouns                 | Use Terminology table above; vendor terms are external labels, not architecture |

### Infrastructure

#### Namespaces

| Namespace          | Purpose                                                   |
| ------------------ | --------------------------------------------------------- |
| `cogni-governance` | Governance workflows (signal collection, routing, agents) |
| `cogni-scheduler`  | User-created scheduled graph executions                   |

#### Task Queues

| Queue              | Workers             | Workflows                 |
| ------------------ | ------------------- | ------------------------- |
| `governance-tasks` | `governance-worker` | Collection, Router, Agent |
| `scheduler-tasks`  | `scheduler-worker`  | ScheduledGraphRun         |

#### Search Attributes

| Attribute                    | Type     | Purpose                              |
| ---------------------------- | -------- | ------------------------------------ |
| `TemporalScheduledStartTime` | DateTime | Authoritative scheduled time         |
| `scope`                      | Keyword  | Filter workflows by governance scope |
| `incidentKey`                | Keyword  | Correlate workflows to incidents     |

### File Pointers

| File                           | Purpose                                                      |
| ------------------------------ | ------------------------------------------------------------ |
| `packages/temporal-workflows/` | Workflow definitions, activity interfaces, activity profiles |
| `services/scheduler-worker/`   | Thin composition root (activity wiring + worker lifecycle)   |
| `packages/scheduler-core/`     | Scheduling types, port interfaces, payload schemas           |

## Acceptance Checks

**Manual:**

1. Verify all Workflow code contains no I/O — only Activity calls, conditionals, and deterministic transforms
2. Verify all Activities are idempotent (check for idempotency keys on side effects)
3. Verify schedules use `overlap: SKIP` and `catchupWindow: 0`

**Automated:**

- `pnpm test` — unit tests for workflow/activity separation patterns

## Open Questions

_(none)_

## Related

- [Scheduler Spec](./scheduler.md) — Scheduled graph execution (user-created)
- [AI Governance Data](ai-governance-data.md) — Governance signal collection and agent workflows
- [Services Architecture](./services-architecture.md) — Worker service structure
