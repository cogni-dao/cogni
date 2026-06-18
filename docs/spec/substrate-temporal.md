---
id: spec.substrate-temporal
type: spec
title: Temporal Substrate — one shared generic worker, per-node queues, node-direct scheduling
status: draft
trust: draft
summary: "How the Temporal substrate serves N nodes without a worker-pod-per-node and without redeploying a shared worker on every node addition. The load-bearing rule: node-specific logic lives in the node's route/graph, never in shared workflow code — so ONE shared worker runs only GENERIC workflows (NodeTaskWorkflow, GraphRunWorkflow) and a new node adds zero worker code. Nodes create schedules directly against provisioned Temporal (operator out of the per-user path); a per-node worker is an opt-in sovereign escape hatch, never the default."
read_when: "Designing how a node runs recurring or triggered durable work; deciding shared-worker vs per-node-worker; reviewing beacon scheduling or task.5035; before routing any node's recurring work through the operator or shipping node logic into the shared worker."
owner: derekg1729
created: 2026-06-18
tags: [temporal, node-baas, substrate, scheduling, sovereignty]
---

# Temporal Substrate

## Context

Temporal is a Cogni **substrate**, like Postgres / Storage / Streams in
[node-baas-architecture.md](./node-baas-architecture.md) § BaaS Substrate Map. Nodes need
durable recurring + triggered work — beacon: a user creates a campaign → scheduled social
posts + metrics ingest. The hard question this doc settles is the **sharing model**: how
does one substrate serve N nodes without either of the two sad outcomes —

- a Temporal **worker pod per node**, or
- **redeploying a shared worker** every time a node adds work.

## The load-bearing insight

A Temporal worker can only execute workflow types whose **code it has registered**. So
_where node-specific logic lives_ decides everything:

- logic in **workflow code** → a shared worker needs every node's code (**redeploy per
  node**), or every node runs its own worker (**a pod per node**). Both sad.
- logic in the **node's own HTTP route / graph** → the shared worker needs only **generic**
  workflows, and serves all nodes with **zero per-node code**.

> **The whole design follows: the shared worker runs ONLY generic workflows; node-specific
> work lives in the node's route/graph. A new node adds zero worker code and triggers no
> redeploy.**

## The substrate (what the operator provisions, once)

- One Temporal cluster; one shared namespace per env (`cogni-<env>`).
- **One shared worker** (`services/scheduler-worker`) registering only **generic** workflows:
  - `NodeTaskWorkflow` — fire a node's HTTP route on schedule (the node's work is _in the route_).
  - `GraphRunWorkflow` — run a node's graph (the node's work is _in the graph_).
  - the operator's own governance/epoch workflows (operator-specific, operator-owned).
- A per-node task queue `scheduler-tasks-<nodeId>` the shared worker polls.
- Per-node Temporal connection creds (scoped to the shared namespace), delivered via ESO
  into the node's secret namespace, so the node's **app** can talk to Temporal directly.

This substrate **does not change when a node is added.**

## How a node consumes it — no worker, operator out of the create path

1. **Create (node-direct).** The node's app holds a Temporal **client** (provisioned creds)
   and calls `schedule.create(action = NodeTaskWorkflow | GraphRunWorkflow, taskQueue = its
own)`. The operator is **not called** — node → Temporal directly. A client is
   request-scoped and cheap; it is **not** a worker.
2. **Execute (shared worker).** On each tick the shared worker runs the generic workflow:
   `NodeTaskWorkflow` `POST`s the node's route under a **per-node dispatch identity**; the
   node's route does the work. `GraphRunWorkflow` runs the node's graph.
3. The node provides: a **client** (to create) + an **HTTP route** (to receive dispatch) +
   a **per-node credential** (to authenticate the dispatch). **Not** a worker, **not**
   custom workflow code.

Net: the operator is out of the per-user **create** path; the shared worker is the durable
**cron + dispatch** substrate (generic, shared); the **work runs in the node**.

## The dispatch tax (honest)

Because the shared worker has no node code, it calls the node over HTTP. That hop costs:

- **per-node identity** — a per-node dispatch credential (or operator-signed token), **never
  a shared master token** (a shared master is a one-way door: leak anywhere → impersonate
  the operator to every node).
- **idempotency** — MVP uses `maximumAttempts: 1` (at-most-once → **no dedup store needed**).
  A retry profile is gated on the node implementing dedup on `Idempotency-Key`. No receipts
  table for MVP.

This tax is the price of _not_ shipping node code into the shared worker — far cheaper than
a per-node worker pod or per-node redeploys.

## The sovereign escape hatch — the ONLY case for a per-node worker

A node that needs **custom durable workflows** (multi-step orchestration, signals, long
human waits — work that cannot be expressed as "fire my route") runs its **own** worker:

- its worker registers its custom workflows + activities and polls **its** queue — the
  per-node queue is the graduation seam (the shared worker stops polling it, or the node
  moves to its own namespace).
- execution is fully in-node; the operator is nowhere.

This is **opt-in**, for nodes that have outgrown HTTP-dispatch. It is **not** the default,
precisely because it costs a pod per node.

## Answering the sharing questions directly

| Question                                           | Answer                                                                                                                                         |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Can one shared worker serve all nodes?             | **Yes** — it runs only generic workflows; node logic is in the node's route/graph.                                                             |
| Can that continue as nodes are added?              | **Yes** — a new node adds a queue + route + creds; **zero** shared-worker code; **no** redeploy.                                               |
| Does every new node spawn its own worker?          | **No** — only nodes that opt into custom workflows. Generic recurring/triggered work needs no node worker.                                     |
| Does the shared worker redeploy per node workflow? | **No** — adding a node adds no workflow type. The shared worker redeploys only when a **generic** workflow changes (a substrate change, rare). |

## Tradeoffs

|                             | Shared generic worker (default)                | Per-node worker (escape hatch)                   |
| --------------------------- | ---------------------------------------------- | ------------------------------------------------ |
| worker pods                 | 1, shared by all nodes                         | 1 per node                                       |
| redeploy on new node        | none                                           | n/a — the node owns + deploys its worker         |
| node-specific workflow code | no (logic in route/graph)                      | yes                                              |
| operator in execution path  | yes — generic dispatch substrate               | no — fully sovereign                             |
| node must run               | a client + a route + a credential              | a client + a worker + its workflows              |
| best for                    | hosted nodes; generic recurring/triggered work | custom durable orchestration / zero operator dep |

## What this means now

- **beacon** — generic recurring work (scheduled posts, metrics ingest) → shared worker via
  `NodeTaskWorkflow`. beacon needs: a Temporal **client** to create schedules + its ops
  **routes** + a **per-node dispatch credential** to verify inbound. **No** own worker, **no**
  `operator_dispatch_receipts` (`maximumAttempts: 1`), **no** operator create API.
  - **Day-1 fallback:** if a Temporal client is too much for the first ship, beacon may run a
    node-local cron and skip the substrate, behind a 2-method `RecurringWorkPort`
    (`schedule`/`cancel`) so the swap to the substrate later is zero product-code change. The
    substrate above is the durable home; cron is a temporary fill of the same port.
- **operator (`task.5035`)** — **provision the substrate** for a node (per-node queue +
  namespace-scoped Temporal creds via ESO) and keep the shared worker's generic workflows.
  **Not** a node-callable schedule API; **not** per-node worker deploys. Schedule creation is
  node-direct.
- **node-template** — ships the Temporal-client + ops-route + `RecurringWorkPort` scaffolding
  as standard; the per-node-worker scaffolding only for the escape-hatch case.

## References

- [node-baas-architecture.md](./node-baas-architecture.md) — substrate provisioning model
  (operator provisions, node consumes directly); add a **Temporal / Recurring** row to the
  BaaS Substrate Map.
- [temporal-patterns.md](./temporal-patterns.md) — workflow determinism, `NodeTaskWorkflow` /
  `GraphRunWorkflow`, schedule config, per-node queue.
- Supersedes the operator-dispatch-as-default framing in
  [node-temporal-tenant-interface.md](../design/node-temporal-tenant-interface.md).
  </content>
