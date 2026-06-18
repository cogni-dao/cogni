---
id: guide.node-temporal
type: guide
title: Using Temporal in a Node — recurring & durable work as a building block
status: draft
trust: draft
summary: "How a node-template node uses the Temporal substrate. Two paths, both running on the shared worker (no node worker required): (1) the pre-existing repo-spec-declared schedules for the node's OWN system-tenant charter jobs; (2) the extensible building block — schedule any route or graph the node owns, the way a node builds arbitrary recurring/AI work. Includes the exact beacon walkthrough."
read_when: "You are a node dev adding recurring, scheduled, or durable work to a node (campaign cadences, metrics ingest, scheduled AI runs); deciding repo-spec schedule vs dynamic schedule; or wondering whether you need your own Temporal worker."
owner: derekg1729
created: 2026-06-18
tags: [temporal, node-template, scheduling, guide]
---

# Using Temporal in a Node

Temporal is a provisioned substrate (see [substrate-temporal.md](../spec/substrate-temporal.md)).
**One shared worker** runs the generic workflows and dispatches the work **into your node** —
so you almost never run your own worker. You schedule **your own routes and graphs**.

There are two ways to use it. Pick by _who owns the schedule_.

---

## Path 1 — repo-spec schedules (system-tenant, the node's own charter jobs)

**Pre-existing.** For the node's **fixed, operator-governed** recurring jobs — not per-user.
Declared in the node's `.cogni/repo-spec.yaml` and reconciled into Temporal by the operator
(`syncGovernanceSchedules`). Governed by git: changing the schedule is a repo-spec PR.

```yaml
# .cogni/repo-spec.yaml
governance:
  schedules:
    - name: collect # a fixed, charter-level recurring job
      cron: "0 * * * *"
```

Use this for: governance signal collection, charter-driven agent runs — **system-tenant**
work that belongs to the node itself and should be version-controlled, not user-toggled.

---

## Path 2 — dynamic node schedules (the building block) ← the extensible use case

For **whatever the node wants** to build: per-user campaigns, ops cadences, scheduled AI
runs. You do **not** write Temporal workflow code or run a worker. You write a **route** or a
**graph** — normal node app code — and schedule it through a generic workflow:

| You wrote…            | Schedule it via…                  | Runs in…           |
| --------------------- | --------------------------------- | ------------------ |
| an HTTP ops route     | `NodeTaskWorkflow` → your `route` | your route handler |
| an AI/LangGraph graph | `GraphRunWorkflow` → your `graph` | your graph runtime |

**"300 different things" = 300 routes/graphs.** The workflow types are fixed and generic; the
variety is your product code. Adding a new scheduled thing never touches Temporal or a worker.

### How beacon uses it (the campaign loop, end to end)

1. **Write the work as a route** (your normal app code), idempotent, logs to Loki:
   `POST /api/internal/ops/growth/metrics-ingest`, `/resolve`, `/post`. For an AI step,
   write a **graph** instead and schedule `GraphRunWorkflow`.
2. **On campaign create**, from your campaign CRUD endpoint, call the node scheduler client
   (node-template scaffolding — the node's own Temporal client):
   ```ts
   await nodeScheduler.schedule({
     id: `campaign:${campaignId}:ingest`, // stable → idempotent re-register
     cron: "*/15 * * * *",
     route: "/api/internal/ops/growth/metrics-ingest", // OR: graph: "growth:summarize"
     payload: { campaignId },
   });
   ```
   This calls **your node's** Temporal client directly — no operator API.
3. **User toggles the campaign** Active/Paused → `nodeScheduler.pause(id)` /
   `nodeScheduler.resume(id)`; delete on campaign delete (`CRUD_AUTHORITY` — the app owns
   schedule lifecycle, never a worker).
4. **The shared worker fires** each tick → dispatches into your route/graph → **your code
   runs in your node.** beacon stores the schedule id on the campaign row; the operator is in
   neither the create nor the work path.

That is the whole integration: write routes/graphs, call `nodeScheduler`. No worker, no
Temporal workflow authoring, no operator call.

---

## When you DO run your own worker (escape hatch — rare)

Only when you need **custom durable orchestration**: multi-step sagas, signals, long human
waits, crash-recovery across a multi-day flow — work that genuinely can't be "fire my
route/graph." Then you add your own workflow defs + a worker pod polling your queue. This is
opt-in and uncommon; do not reach for it for cron-style jobs.

## The rules (hold inside your node exactly as in the operator)

- `SCHEDULES_OVER_CRON`, `CRUD_AUTHORITY` (the app owns create/pause/delete), `TEMPORAL_DETERMINISM`,
  `ACTIVITY_IDEMPOTENCY` — see [temporal-patterns.md](../spec/temporal-patterns.md).
- **AI runs in activities/graphs, never in workflow code.**
- Dispatch is at-most-once (`maximumAttempts: 1`) for MVP — make your route idempotent.

## References

- [substrate-temporal.md](../spec/substrate-temporal.md) — the substrate (shared worker,
  node-direct create, per-node queue, the escape hatch).
- [temporal-patterns.md](../spec/temporal-patterns.md) — the build rules + the generic workflows.
  </content>
