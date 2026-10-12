---
id: spec.substrate-temporal
type: spec
title: Temporal Substrate — node-sovereign durable agent workflows
status: draft
trust: draft
summary: "The operator manages Temporal as shared infrastructure; each node owns and releases its workflow definitions, LangGraph graphs, private Worker service, and schedule lifecycle inside an environment-scoped node namespace."
read_when: "Designing scheduled or durable agent work; adding a node Workflow or Worker; provisioning Temporal identity; changing schedule or queue topology; investigating a missing poller."
owner: derekg1729
created: 2026-06-18
verified: 2026-10-09
tags: [temporal, node-baas, substrate, scheduling, sovereignty]
---

# Temporal Substrate

## Decision

Cogni provides a shared Temporal **service**, not a shared fleet-wide node **Worker**.

Every node owns and releases:

- `packages/graphs`: LangGraph definitions and effective graph catalog;
- `packages/workflows`: Temporal Workflow definitions, input schemas, and Activity contracts;
- `services/workflow-worker`: Worker composition, Activity adapters, health, metrics, and lifecycle;
- `RecurringWorkPort` in the node app: node-direct schedule CRUD and repo-spec reconciliation.

The operator owns the substrate: Temporal service operation, one namespace and runtime identity
per `(node, environment)`, secret materialization, deployment wiring, visibility, and
decommissioning. Operator governance and ledger workflows remain operator-owned Workers.

This is the same BaaS boundary as Postgres: the operator provisions and operates the service;
the node owns its schema and product behavior.

## Why the centralized node Worker is the wrong release boundary

The current `scheduler-worker` is a useful compatibility implementation, but a fleet-wide
Worker cannot be the permanent home of node product workflows:

1. A node cannot add or version custom durable orchestration without an operator release.
2. The Worker must know the namespace × node routing matrix. bug.5212 showed the failure mode:
   a namespace existed, but no Worker polled the corresponding node queue.
3. Node-specific Workflow types cannot safely share one Task Queue unless every poller carries
   identical registrations.
4. App and Worker code can drift unless they ship from one source-SHA artifact bundle.
5. A per-node Task Queue is not an authorization boundary. Shared namespace credentials expose
   shared visibility and control.

Temporal's intended split supports this decision: application teams deploy their own Workers;
the Temporal Service remains shared infrastructure. Task Queues route work; Namespaces isolate
credentials, visibility, retention, limits, and operational ownership.

This conclusion follows Temporal's current production guidance: applications control and deploy
their own [Workers](https://docs.temporal.io/production-deployment/worker-deployments);
[Task Queues](https://docs.temporal.io/task-queue) are routing/load-balancing primitives and all
pollers on one queue must register compatible handlers; [Namespaces](https://docs.temporal.io/namespaces)
are the isolation and access-control unit. Temporal recommends per-tenant Task Queues for most
multi-tenant SaaS, but calls out namespace-per-tenant when credentials, dashboards, limits, or
compliance are tenant boundaries. Cogni nodes meet that stronger ownership test; see
[multi-tenant patterns](https://docs.temporal.io/best-practices/multi-tenant-patterns).

## Product unit: durable agent workflow

A durable agent workflow is a node-owned Temporal Workflow containing one or more LangGraph
graph runs plus durable Activities, child Workflows, timers, or signals.

```text
schedule / API / webhook
  → node Temporal Workflow                    durable coordination
      → child/Activity: LangGraph run          reasoning and dataflow
      → timer/signal/branch                    long-lived orchestration
      → Activity: external write               idempotent material effect
```

Temporal does not automatically checkpoint internal LangGraph nodes when the graph executes as
one Activity. If a graph must resume within the graph, it also needs a persistent LangGraph
checkpointer and stable `thread_id`. See
[LangGraph persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) and
[LangGraph Patterns](./langgraph-patterns.md).

## Runtime topology

```text
operator-managed Temporal service
  ├─ cogni-candidate-a-<nodeId>
  │    └─ agent-workflows  ← node candidate Worker
  ├─ cogni-preview-<nodeId>
  │    └─ agent-workflows  ← node preview Worker
  ├─ cogni-production-<nodeId>
  │    └─ agent-workflows  ← node production Worker
  └─ cogni-<env>-operator
       ├─ governance       ← operator Worker
       └─ ledger-tasks     ← operator Worker
```

### Namespace and identity

The namespace is the hard tenant boundary. Its name derives from immutable `node_id`, never a
mutable display slug. Each node app and Worker receives a runtime identity scoped to exactly its
environment namespace. A missing scoped identity fails deployment; a shared namespace
credential is not a production fallback.

Creating separate namespaces without enforcing namespace-scoped authentication is insufficient.
On self-hosted Temporal the operator must provide the corresponding authorizer/authentication
boundary; network reachability alone is not node identity.

Namespace-per-node has more provisioning overhead than a shared namespace with per-tenant Task
Queues. Cogni chooses it because nodes are independent communities with separate code, release
cadence, operational visibility, and eventual custody. The current fleet is also within the
range where namespace-per-tenant is operationally reasonable. Provisioning must be automated,
not hand-maintained.

### Task Queue and Worker versioning

Each node namespace starts with one stable logical queue: `agent-workflows`. It is not named for
a pod or build. The Worker Deployment name is `node-<nodeId>-workflows`; its Build ID is the
exact git source SHA.

- short scheduled workflows: `PINNED`;
- long-lived agent/entity workflows: `PINNED` with Continue-as-New upgrade boundaries;
- incompatible code never replaces a still-required build in place;
- a second queue is added only for a proven workload-class isolation need.

This follows Temporal's recommendation that
[Worker Versioning](https://docs.temporal.io/production-deployment/worker-deployments/worker-versioning)
be the default production deployment model; AI agents that live across deployments use pinning
with Continue-as-New upgrade boundaries.

The concrete release handshake is health-gated: the Worker starts with `useWorkerVersioning`,
deployment name `node-<nodeId>-workflows`, and source SHA as Build ID; its health response exposes
that identity. The app verifies the expected SHA, sets the version current through its node-scoped
Temporal client, verifies the routing state, and only then reconciles schedules. This requires
Temporal TypeScript SDK >=1.12 and server >=1.29.1; Temporal UI >=2.38 is an operational
prerequisite before production support. Startup alone never promotes a Worker version.

### Deployment

The node's repo-spec declares `workflow-worker` as a private service. The existing exact-set
artifact bundle builds the public app and private Worker from one source SHA, and the operator
materializes them as one workload revision. `NODE_APP_URL` is a sibling binding, not a public
URL.

The service opts into `runtime_profile: cogni-workflow-worker-v1`. Like
`cogni-node-app-v1`, the profile owns its standard runtime contract: Temporal address,
node/environment namespace, namespace-scoped authentication material, stable Task Queue, node
identity, build/version identity, health port, and the private URL of the required app sibling.
Nodes declare only additional secrets and non-standard bindings. This
requires extending repo-spec runtime profiles to support the private Worker profile; copying the
standard secret list into every node repo is rejected because it drifts.

The first implementation admits this profile only in candidate/preview. It provisions the
per-node namespace and wires the Worker, but production materialization fails closed until the
self-hosted Temporal service enforces namespace-scoped authentication and authorization. A
namespace without that server-side boundary is useful for pre-production routing proof, not a
production tenant boundary.

The Worker exposes only health/metrics. It opens no public ingress and connects outward to
Temporal. The app owns schedule CRUD; the Worker never creates, updates, or deletes schedules.
`/readyz` returns node ID, namespace, Task Queue, deployment name, Build ID, and registered
Workflow types. Before activation/reconciliation, the app verifies those fields against its own
repo-spec and source SHA; an unknown declared Workflow type fails reconciliation instead of
creating a schedule that can never execute.

The migration seam is explicit. Existing app code continues to read `TEMPORAL_*` and
`SCHEDULER_WORKER_HEALTH_URL` for the centralized compatibility lane. `RecurringWorkPort` reads
`AGENT_WORKFLOW_TEMPORAL_*`, and app readiness reads `AGENT_WORKFLOW_WORKER_HEALTH_URL`, for the
node-owned lane. In P0, only schedule entries with the explicit `workflow` target enter that
lane; existing `graph` and `route` entries remain on the compatibility lane. Merely declaring or
deploying a Worker therefore cannot duplicate existing billable schedules. The node-owned client
is enabled only in environments where the Worker service materializes. Moving graph/route sugar
later requires an explicit versioned schedule-contract cutover, never inference from Worker
presence.

### One-call substrate health

Temporal wiring must never be inferred from process uptime or the absence of errors. Every node
ships an authenticated `GET /api/v1/temporal/health` diagnostic and a thin
`pnpm temporal:health -- --env <env>` command that calls the deployed node endpoint with the
node-agent credential. The endpoint returns one bounded snapshot (five-second total budget):

- resolved mode (`compatibility` or `sovereign`), namespace, Task Queue, node ID, environment,
  and app source SHA;
- Temporal frontend/namespace reachability;
- server-observed Workflow and Activity pollers, including their last-access times;
- private Worker readiness, registered Workflow catalog, deployment name, and Build ID;
- current Worker Deployment Version and whether it exactly matches the app source SHA;
- declared/reconciled/paused schedule counts plus stable drift reason codes; and
- the most recent due schedule action and Workflow result, when one is expected.

The response is `healthy`, `degraded`, or `unhealthy`; it is never green merely because the app
can open a Temporal connection. A sovereign lane is healthy only when both poller types are fresh,
the private Worker identity/catalog match the node declaration, the current Build ID equals the
app SHA, and schedule drift is zero. A compatibility lane is named as such rather than masquerading
as sovereign. Raw Workflow input, results, tokens, secrets, and prompts are never returned.

The CLI renders the failed checks and exits non-zero for `degraded`, `unhealthy`, authentication,
timeout, or malformed responses. It is the first operator/node-agent diagnostic and the
candidate-flight evidence source. `/readyz?deep=1` reuses the same inspector and fails closed;
ordinary `/readyz` remains serving-readiness and does not drain public traffic for an asynchronous
substrate outage.

The health inspector emits exactly one terminal `substrate.temporal.health_checked` event with a
stable reason code and duration. Metrics record the last successful inspection timestamp, current
poller presence by task type, schedule drift count, and inspection result/duration. All inherit
`nodeId` / `node_id`; no run, schedule, Workflow, or Build ID becomes a metric label. The operator
probes this endpoint on a fixed interval and alerts when a required poller disappears, exact-SHA
routing diverges, schedule drift persists, or successful inspection goes stale. Worker logs remain
available independently through the standard per-service log proxy, including crash loops.

## Graph execution: preserve one billed path

The Pareto implementation keeps graph execution in the node app:

```text
node Workflow
  → runGraph Activity
      → POST http://app:<port>/api/internal/graphs/<graphId>/runs
          → GraphExecutorPort
          → execution_requests dedup
          → graph_runs + charge_receipts + telemetry
```

This private sibling hop is preferable to directly importing the graph execution host into the
Worker for P0. The app path already enforces grants, billing, idempotency, streaming, and
observability. Direct Worker execution is allowed later only when that complete host contract is
process-portable and the HTTP path is replaced rather than duplicated.

## Node authoring contract

Node-template includes a working starter, not an empty abstraction:

```text
packages/
  graphs/                    # node LangGraph catalog
  workflows/                 # node Temporal Workflow catalog
services/
  workflow-worker/           # private Worker service
```

`schedules[]` supports three targets:

| Target     | Meaning                                                               |
| ---------- | --------------------------------------------------------------------- |
| `workflow` | First-class node-owned Workflow type                                  |
| `graph`    | Convenience starter Workflow that runs one graph                      |
| `route`    | Compatibility starter Workflow that dispatches one private node route |

Workflow input is validated by one strict schema before schedule creation and again at the
Workflow boundary. Schedule reconciliation compares workflow type, input, calendar/cron,
timezone, and Task Queue. `overlap=SKIP` and `catchupWindow=0` remain platform defaults.

## Published substrate package

Reusable mechanics ship as `@cogni-dao/agent-workflow-runtime`, sourced from node-template:

- starter scheduled graph/route Workflow definitions;
- schedule and Workflow input contracts;
- standard Activity retry/timeout profiles;
- Worker bootstrap, health, metrics, and graceful shutdown helpers;
- stable queue/deployment naming helpers.

This is a thin Cogni contract, not a framework facade. A node's own package manifests pin and
import `@temporalio/workflow`, `@temporalio/worker`, and `@langchain/langgraph` directly. Nodes keep
the official SDK programming models, types, replay rules, and upgrade paths; the Cogni package
only supplies the repeated platform integration needed to run those SDKs on the managed substrate.

It contains no node graph catalog, workflow policy, secrets, process-specific adapters, or
operator governance/ledger code. It follows the knowledge/work-items package path: immutable
attested GitHub Release tarball, anonymous install, exact version pin, and no `workspace:*`
runtime dependencies. Poly is the first external consumer; propagation to existing nodes is
vNext after node-template and Poly prove it.

The current `@cogni/temporal-workflows` package is split by ownership:

- reusable node starter mechanics move to the published runtime;
- operator governance, review, and ledger Workflows remain operator-owned;
- node-specific Workflows remain in each node's `packages/workflows`.

## Lifecycle contract

### Add or upgrade

1. Node repo declares Worker service, schedules, and secret keys.
2. Operator provisions namespace and scoped runtime identity.
3. CI publishes the exact-set app + Worker artifact bundle from one source SHA.
4. Operator deploys both services; Worker readiness proves a poller on `agent-workflows`.
5. Node app verifies the Worker's Build ID, activates that exact Worker Deployment Version, then
   reconciles schedules.
6. `pnpm temporal:health -- --env <env>` returns healthy with fresh Workflow and Activity pollers,
   exact-SHA routing, and zero schedule drift.
7. Validation records the health snapshot, namespace, Task Queue, Workflow/run IDs, Worker Build
   ID, app build SHA, graph run, and final result.

### Remove

1. Pause schedules.
2. Wait for or explicitly cancel active executions by declared policy.
3. Delete schedules and revoke the namespace-scoped runtime identity.
4. Stop the Worker.
5. Retain/archive/delete the namespace under the environment retention policy.

No static environment variable list is an ownership source for namespace lifecycle.

## Migration from the centralized Worker

A big-bang queue rename would orphan live schedules or double-execute billable runs. Migration is
per node and fail-closed:

1. Publish the runtime and add the node-template Worker service.
2. Provision the node-template namespace and deploy app + Worker from one artifact bundle.
3. Pause each old graph/route schedule before replacing it with an explicit `workflow` entry in
   the node namespace; preserve the stable business idempotency key; prove the new poller; then
   delete the old schedule.
4. Prove one scheduled Temporal Workflow containing a LangGraph run on node-template.
5. Repeat with a Poly-owned Workflow on Poly.
6. Remove node-template and Poly queues/namespaces from centralized worker compatibility routing.
7. Keep operator governance/ledger Workers unchanged.
8. vNext: propagate the proven package/service contract to existing nodes.

At no point are both old and new schedules enabled. `TEMPORAL_CUSTODIED_NAMESPACES` and
`COGNI_NODE_ENDPOINTS` remain compatibility inputs only until the last migrated node leaves the
central worker.

## Acceptance evidence

For node-template and Poly independently, capture:

1. deployed app and Worker artifacts resolve to the same source SHA;
2. Worker poller is healthy in the node's environment namespace on `agent-workflows`, and the
   current Worker Deployment Version Build ID equals that source SHA;
3. a Temporal Schedule starts the intended node-owned Workflow type;
4. that Workflow contains a LangGraph graph run through `GraphExecutorPort`;
5. `execution_requests`, `graph_runs`, billing receipt, logs/metrics, and Temporal history agree
   on one execution identity;
6. the authenticated Temporal health endpoint and CLI report healthy, exact-SHA, fresh Workflow
   and Activity pollers, zero schedule drift, and the expected completed run; and
7. the old centralized schedule is absent or paused, proving no duplicate billable path.

## Rejected shapes

- **One fleet-wide Worker for node product workflows:** couples node code and releases to the operator.
- **Dynamic loading of node Workflow code into the central Worker:** unsafe supply-chain and replay boundary.
- **Shared namespace as the final tenant boundary:** Task Queues do not scope credentials or visibility.
- **Direct graph execution in both app and Worker:** duplicates billing/idempotency/telemetry paths.
- **A second scheduler:** Temporal Schedules remain authoritative.
- **Big-bang migration:** risks orphaned schedules and duplicate execution.

## References

- [Temporal Patterns](./temporal-patterns.md) — determinism, schedule semantics, Worker versioning, and migration.
- [LangGraph Patterns](./langgraph-patterns.md) — graph runtime, persistence, and the Temporal boundary.
- [Node BaaS Architecture](./node-baas-architecture.md) — node-declares/operator-wires ownership model.
- [Substrate Access-Grant Plane](./substrate-access-grant.md) — why namespace, not Task Queue, is the Temporal auth boundary.
- [Temporal TypeScript durable-agent samples](https://github.com/temporalio/samples-typescript/tree/main/openai-agents) — agent orchestration in Workflows with model/tool I/O in Activities.
- [node-template package publication #144](https://github.com/cogni-dao/node-template/pull/144) and [#152](https://github.com/cogni-dao/node-template/pull/152) — immutable GitHub Release package precedent.
- [Poly package adoption #199](https://github.com/cogni-dao/poly/pull/199) — pinned consumer precedent without vendored copies.
