---
id: temporal-patterns-spec
type: spec
title: Temporal Patterns
status: active
spec_state: draft
trust: draft
summary: Node-sovereign durable agent workflow patterns — Temporal orchestration, LangGraph execution, schedule configuration, package ownership, and infrastructure layout.
read_when: Writing Temporal workflows or activities, configuring schedules, or debugging replay issues.
owner: derekg1729
created: 2026-02-06
verified: 2026-10-09
tags: [ai-graphs, infra]
---

# Temporal Patterns

## Terminology

| Term                       | Definition                                                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workflow**               | A Temporal Workflow — the top-level durable execution unit. Deterministic, replay-safe.                                                     |
| **Workflow run**           | One Temporal execution of a Workflow, plus any optional app-side run record if the product chooses to persist one.                          |
| **Graph**                  | A LangGraph execution unit, typically invoked via `GraphRunWorkflow` and exposed as a workflow step in the product model.                   |
| **Graph run**              | A `GraphRunWorkflow` child execution + its `graph_runs` record. Drill-down detail of a parent.                                              |
| **Activity**               | A Temporal Activity — all I/O lives here. Retryable, idempotent.                                                                            |
| **Agent**                  | An app-level `AgentDefinition` — a named configuration that selects a graph + model + tools.                                                |
| **Tool**                   | A callable capability exposed to graphs/agents (MCP tools, API calls, etc.).                                                                |
| **Durable agent workflow** | A node-owned Temporal Workflow that composes one or more LangGraph graph runs with durable Activities, timers, signals, or child Workflows. |

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

10. **SINGLE_INPUT_CONTRACT**: Each parent Workflow's input shape is defined exactly once as a `.strict()` Zod schema beside the Workflow (`packages/workflows` for a node; the operator-owned workflow package for operator Workflows), consumed via `z.infer<typeof Schema>` at every call site. Producers parse with the schema before `workflowClient.start(...)`.

11. **NODE_OWNS_WORKFLOW_CODE**: A node's product workflows, Activity adapters, graph catalog, and Worker release live in that node's repository and artifact bundle. The operator does not load node workflow code into a fleet-wide Worker.

12. **OPERATOR_OWNS_TEMPORAL_SUBSTRATE**: The operator provisions and operates Temporal, namespace-scoped runtime identity, secrets, visibility, and deployment wiring. It does not author or release a node's product workflows.

13. **ONE_NODE_ONE_NAMESPACE**: Each `(node, environment)` receives a namespace (`cogni-<env>-<nodeId>`). A Task Queue is a routing and throughput boundary, not an authorization boundary. Namespace-scoped credentials are required before node-direct schedule control is production-safe.

14. **APP_WORKER_SAME_SOURCE_SHA**: A node's public app and private workflow-worker are built from one commit, published in one exact-set artifact bundle, and deployed as one workload revision. Schedule creation must never target workflow code that is absent from the deployed Worker revision.

15. **ONE_GRAPH_EXECUTION_PATH**: During the Pareto migration, a Workflow invokes a graph through the node app's existing internal graph-run API. This preserves `GraphExecutorPort`, billing, run persistence, idempotency, and telemetry. Direct in-Worker graph execution is allowed only after it implements those same contracts and replaces, rather than duplicates, the HTTP path.

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

### Node-sovereign durable agent workflows

The canonical node product unit is a **durable agent workflow**: node-owned Temporal
orchestration that calls node-owned LangGraph graphs. Temporal is the durable outer control
plane; LangGraph is the reasoning/dataflow inner runtime. The operator supplies the Temporal
substrate and deploys the declared service, while the node owns the code and release.

The model is **declare → provision → create → execute**.

**1. Declare.** A node declares its private Worker service in `deployment.services` and recurring
entries in `schedules[]`. `workflow` is the first-class target; `graph` and `route` remain
convenience targets implemented by starter workflows in the node-owned Worker.

```yaml
# .cogni/repo-spec.yaml — the node-author-facing contract
schedules:
  - id: nightly-market-brief
    cron: "0 0 * * *"
    timezone: UTC
    workflow: NightlyMarketBriefWorkflow
    payload: { graphId: "poly:research", market: "daily" }

deployment:
  services:
    # public app omitted for brevity
    - name: workflow-worker
      artifact:
        name: workflow-worker
        context: .
        dockerfile: services/workflow-worker/Dockerfile
      port: 9090
      visibility: private
      envs: [candidate-a, preview]
      runtime_profile: cogni-workflow-worker-v1
      bind_host: 0.0.0.0
      resources: { cpu_units: 0.5, memory_mi: 512, storage_mi: 512 }
```

**2. Provision.** The operator creates the node's environment-scoped namespace and runtime
identity, materializes the secrets, and deploys the private Worker from the same source-SHA
artifact bundle as the app. The `cogni-workflow-worker-v1` runtime profile owns the standard
Temporal connection, namespace, identity, queue, and health contract so nodes do not copy a
secret list. It also derives the private `NODE_APP_URL` from the required app-profile sibling.
Namespace lifecycle is catalog-driven; no static
`TEMPORAL_CUSTODIED_NAMESPACES` list is an ownership source.

Rollout is fail-closed: candidate/preview may prove namespace routing before server auth lands,
but production materialization rejects the Worker profile until the self-hosted Temporal server
enforces namespace-scoped authentication and authorization.

**3. Create — node-direct.** The node app owns `RecurringWorkPort` and its Temporal client. P0
reconciles repo-spec entries carrying the explicit `workflow` target into its own namespace on
the stable `agent-workflows` Task Queue. Existing `graph` and `route` entries remain on the
centralized compatibility lane until each is deliberately migrated. The operator is out of CRUD
for node-owned entries. Reconciliation compares workflow type, input, cron/calendar, timezone,
and Task Queue; a queue change is never silently skipped.

During migration this client reads `AGENT_WORKFLOW_TEMPORAL_*`. The app's legacy `TEMPORAL_*`
client and `SCHEDULER_WORKER_HEALTH_URL` remain unchanged until its old schedules are paused and
removed. The new Worker profile must never globally retarget existing Temporal callers as a
side effect of being declared. If the private Worker is environment-gated out, node-workflow
reconciliation is disabled in that environment.

**4. Execute — node-owned Worker.** `services/workflow-worker` imports the node's workflow
bundle, registers the node's Activities, and polls `agent-workflows`. A graph step calls the
node app's private graph-run endpoint so all graph execution still flows through
`GraphExecutorPort` and the existing billing/idempotency/telemetry path.

#### Create → execute flow

```
node app: RecurringWorkPort.reconcile(repoSpec.schedules)
  → node-scoped Temporal client → cogni-<env>-<nodeId>
  → schedule.create/update on agent-workflows
       action.workflowType = declared workflow | starter graph/route workflow
       overlap=SKIP, catchupWindow=0s

node service: workflow-worker (same source SHA as app)
  → NightlyMarketBriefWorkflow
       → executeChild(ScheduledGraphWorkflow)
            → Activity: POST http://app:<port>/api/internal/graphs/<graphId>/runs
               Idempotency-Key: <namespace>/<scheduleId>/<scheduledFor>/<step>
       → Activity: publish/persist externally visible result
```

The operator's governance and ledger workflows remain operator-owned and may keep an
operator Worker. "No centralized node Worker" does not mean "no shared Temporal service" or
"no operator Worker"; it means node workflow code never depends on a fleet-wide Worker release.

#### Invariants specific to node-as-tenant

| Invariant                            | Rule                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **WORKFLOWTYPE_NODE_OWNED**          | The node declares a `workflow`, `graph`, or `route`; `graph`/`route` map to node-owned starter workflows. Workflow names must exist in the deployed node bundle.        |
| **PLATFORM_OVERLAP_AND_CATCHUP**     | `overlap`/`catchupWindow` are NOT in the node-facing schema. The operator fixes `skip`/`0s`; a node cannot tune them.                                                   |
| **FULL_ACTION_DRIFT**                | Reconcile compares stored cron/calendar plus workflow type, input, timezone, and Task Queue. It must update on any action drift.                                        |
| **NODE_ID_PINNED**                   | Namespace, runtime identity, and schedule IDs are derived from the repo-spec's own `node_id`; a node cannot author a foreign-node schedule.                             |
| **NAMESPACE_CREDENTIAL_FAIL_CLOSED** | App and Worker receive credentials scoped to their node namespace; missing scope fails deployment. Shared namespace credentials are not a production fallback.          |
| **TEARDOWN_DRAINS**                  | Decommission pauses schedules, waits/cancels active executions by policy, revokes the runtime identity, stops the Worker, then retains/deletes the namespace by policy. |

#### Idempotency is a two-sided contract

The Worker's graph Activity forwards a stable idempotency key; the node app **must** dedup it.
A key the receiver ignores does not make a POST idempotent. Retries are enabled only after the
receiver contract is proven. `execution_requests` and billing receipts remain the correctness
layers for graph execution.

#### Package and service ownership

| Surface                                            | Owner                   | Contract                                                                                                                          |
| -------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `packages/graphs`                                  | node                    | LangGraph definitions and effective catalog                                                                                       |
| `packages/workflows`                               | node                    | Temporal Workflow definitions, schemas, and Activity interfaces                                                                   |
| `services/workflow-worker`                         | node                    | Worker composition, Activity adapters, health, and process lifecycle                                                              |
| `@cogni-dao/agent-workflow-runtime`                | node-template substrate | Published starter workflows, worker bootstrap, retry profiles, schedule contracts, health/metrics helpers; no node business logic |
| Temporal service + namespace/identity provisioning | operator                | Shared control/data plane, one namespace and credential boundary per `(node, env)`                                                |

The substrate package follows the work-items/knowledge-store publication pattern: node-template
is the source of truth; immutable, attested GitHub Release tarballs are anonymously consumable;
node repos pin exact versions. It must not ship `workspace:*` runtime dependencies. Poly proves
consumer adoption before existing-node propagation.

It also must not hide the official SDKs. Node-owned graphs and Workflows directly import pinned
`@langchain/langgraph` and `@temporalio/*` packages; the Cogni runtime adds the managed namespace,
schedule, worker-lifecycle, health, and observability contract around them.

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

Namespaces are the authorization, visibility, retention, and operational boundary. Each node
gets one namespace per environment; the operator has its own.

| Namespace              | Purpose                                                 |
| ---------------------- | ------------------------------------------------------- |
| `cogni-<env>-<nodeId>` | Node-owned workflows and schedules for exactly one node |
| `cogni-<env>-operator` | Operator governance/ledger workflows only               |

#### Task Queues

Inside a node namespace, `agent-workflows` is the stable default queue. It is a logical service
queue, not a per-process queue. The node Worker uses Temporal Worker Versioning with deployment
name `node-<nodeId>-workflows` and source commit as Build ID. Short scheduled workflows are
`PINNED`; long agent/entity workflows use `PINNED` plus Continue-as-New upgrades.

Versioning is a release protocol, not just Worker configuration. The runtime package requires
Temporal TypeScript SDK >=1.12 and a self-hosted server >=1.29.1. After the Worker health endpoint
reports the expected source-SHA Build ID, `RecurringWorkPort` idempotently sets that deployment
version current, verifies it through Temporal, and only then reconciles schedules. A Worker never
self-promotes before its app peer verifies exact-SHA readiness. Temporal UI >=2.38 is an
operational prerequisite before this becomes a production-supported lane.

The private `/readyz` response includes node ID, namespace, Task Queue, deployment name, Build ID,
and registered Workflow types. The app matches all six against its repo-spec and expected source
SHA before activating the version. A declared `workflow` missing from that catalog is a hard
reconcile error, not a schedule that is allowed to fail later.

Node operators do not diagnose this chain by reading startup logs. Every node exposes the bounded,
authenticated `/api/v1/temporal/health` snapshot defined in
[Temporal Substrate](./substrate-temporal.md#one-call-substrate-health), and node-template ships
`pnpm temporal:health -- --env <env>` as its stable human/agent entry point. The inspector asks
Temporal directly for fresh Workflow and Activity pollers, then joins that server-side truth with
the private Worker's catalog/Build ID and the app's schedule-reconciliation state. A process being
alive, a successful connection, or an old poller entry is insufficient.

> **As-built divergence:** the centralized `scheduler-worker` currently polls every node queue
> across one or more environment namespaces, driven by `COGNI_NODE_ENDPOINTS` and
> `TEMPORAL_CUSTODIED_NAMESPACES`. That static cross-product caused bug.5212 when a namespace was
> added without a corresponding poller. It remains the compatibility lane only while schedules
> migrate; it is not the target ownership model.

#### Pareto migration without orphaning schedules

1. **Package and template:** publish `@cogni-dao/agent-workflow-runtime`; add node-owned
   `packages/workflows` and private `services/workflow-worker` to node-template.
2. **Provision and prove node-template:** create its node namespace/identity, dual-register the
   existing generic scheduled graph workflow, deploy app + Worker from one artifact bundle, then
   activate the health-verified source SHA as the current Worker Deployment Version.
3. **Migrate schedules:** pause each old schedule, create the equivalent schedule in the new
   namespace with the same business identity/idempotency key, verify its poller, then delete the
   old schedule. Never leave both enabled.
4. **Prove Poly:** adopt the pinned package, add one Poly-owned durable workflow containing a
   LangGraph graph run, and capture poller/run/exact-SHA evidence on candidate/preview.
5. **Retire node lanes:** remove migrated nodes from centralized worker routing. Keep operator
   governance/ledger workflows on operator-owned Workers.
6. **vNext propagation:** port the proven package/service declaration to existing nodes; do not
   fork-copy unproven worker code across the fleet.

#### Search Attributes

| Attribute                    | Type     | Purpose                              |
| ---------------------------- | -------- | ------------------------------------ |
| `TemporalScheduledStartTime` | DateTime | Authoritative scheduled time         |
| `scope`                      | Keyword  | Filter workflows by governance scope |
| `incidentKey`                | Keyword  | Correlate workflows to incidents     |

### File Pointers

| File                             | Purpose                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `packages/temporal-workflows/`   | Current operator-owned workflow bundle; compatibility source during migration     |
| `services/scheduler-worker/`     | Current centralized compatibility worker; operator-only target                    |
| node `packages/workflows/`       | Node-owned product workflows and Activity contracts                               |
| node `services/workflow-worker/` | Node-owned Worker composition and lifecycle                                       |
| `packages/scheduler-core/`       | Current scheduling ports and schemas to split/publish through the runtime package |

## Acceptance Checks

**Manual:**

1. Verify all Workflow code contains no I/O — only Activity calls, conditionals, and deterministic transforms
2. Verify all Activities are idempotent (check for idempotency keys on side effects)
3. Verify schedules use `overlap: SKIP` and `catchupWindow: 0`
4. Verify the current Worker Deployment Version Build ID equals the app and bundle source SHA
5. Run `pnpm temporal:health -- --env <env>` and verify both poller types are fresh, schedule drift
   is zero, and the most recent due execution has a terminal result

**Automated:**

- `pnpm test` — unit tests for workflow/activity separation patterns

## Open Questions

_(none)_

## Related

- [Scheduler Spec](./scheduler.md) — Scheduled graph execution (user-created)
- [AI Governance Data](ai-governance-data.md) — Governance signal collection and agent workflows
- [Services Architecture](./services-architecture.md) — Worker service structure
