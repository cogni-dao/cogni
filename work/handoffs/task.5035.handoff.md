---
work_item_id: task.5035
status: needs_design
branch: derekg1729/task-5035-node-targetable-cron (not yet cut — branch from origin/main)
last_commit: 8166ea9 (origin/main has #1741 merged — build from main, not this design branch)
---

# task.5035 — node-targetable cron (story.5008)

## Mission

Pickup: the Temporal schedule substrate is shipped + proven (T1 merged; #1741 proved the
operator-self NodeTask dispatch loop on candidate-a, idempotency-keyed, read back in Loki).
It is functionally cron. **The one product gap:** a schedule's `nodeId` is effectively pinned
to the operator, so it can only fire **operator** routes. Make it **node-targetable** so a
**beacon** "campaign" schedule (user-created recurring posts/analytics = cron) dispatches to
**beacon's** route. beacon owns the campaign↔schedule mapping in beacon's own DB; the operator
is a dumb per-node trigger. **It's cron — do not over-build it.**

## ⚠️ CORRECTED guardrail (authoritative — supersedes the "shared token" line in earlier task text)

Do **NOT** use the shared `SCHEDULER_API_TOKEN` for the tenant path. That is the model we are
**killing** — a one-way door: leak it anywhere → impersonate the operator everywhere.
**Per-node identity, both legs:**

- **Control plane (create seam):** beacon calls the create route with its **own `cogni_ag_sk_`
  agent key**. The authenticated principal *is* the node → that resolves `nodeId`. The caller
  does not get to assert an arbitrary `nodeId` behind a shared secret.
- **Data plane (dispatch):** the operator dispatches under a **per-node credential** — reuse
  T1's `createFailClosedNodePrincipalResolver` (fail-closed), backed by **beacon's own dispatch
  token via ESO**. **NOT** `createSharedTokenNodePrincipalResolver`.
- `TENANT_PRINCIPAL_FAIL_CLOSED` in `temporal-patterns.md` **HOLDS — keep it.** Do not ship code
  that contradicts it.
- **OPEN (manager confirms before the data-plane build): R1 per-node dispatch token vs R2
  operator-signed JWT.** This is the crux; `rbac-expert` is the required reviewer.

## Goal

A schedule created for a **non-operator** `nodeId` (beacon) dispatches to **that node's** route,
under that node's own identity, and is observed in Loki at the deployed SHA.

**E2E / candidate-a proof (DoD):** flight the PR → create a schedule with `nodeId = beacon` +
a beacon route via the node-authed create seam (beacon's agent key) → `NodeTaskWorkflow` fires →
`dispatchNodeTaskActivity` POSTs **beacon's** route → the dispatch log appears in Loki under
beacon's stream (`namespace="cogni-candidate-a"`, beacon pod), idempotency-keyed
`beacon-nodeId/scheduleId/scheduledFor`. Post a `/validate-candidate` scorecard on the PR.
**VERIFY first:** beacon must be in the scheduler-worker `COGNI_NODE_ENDPOINTS` or dispatch
throws `Unknown nodeId` (bug.5021 trap) — confirm before claiming E2E.

## Start By Reading

- **`docs/design/node-temporal-tenant-interface.md` § "MVP vs vFuture — it's cron; don't
  over-build it"** — the authoritative scope (note: this section is currently uncommitted in the
  worktree; preserve it). The correction above tightens its auth model.
- `docs/spec/temporal-patterns.md` (NodeTask / node-as-tenant, `TENANT_PRINCIPAL_FAIL_CLOSED`)
  and `docs/spec/node-baas-architecture.md` (§ BaaS Substrate Map — F2 is the aligned vFuture).
- `packages/db-client/src/adapters/drizzle-schedule.adapter.ts` — **line 133** binds the grant
  scope via `nodeTaskScope(this.nodeId, route)` using the **ctor pin** (`this.nodeId` = operator,
  line 110); line 183 already stores `input.nodeId` on the row. **The scope is the bug.**
- `services/scheduler-worker/src/adapters/node-principal.ts` — `createSharedTokenNodePrincipalResolver`
  (MVP, currently wired by task.5034) vs `createFailClosedNodePrincipalResolver` (the per-node seam to wire).
- `services/scheduler-worker/src/bootstrap/container.ts` — where the resolver is wired (switch leg).
- `nodes/operator/app/src/app/api/v1/schedules/route.ts:145` — user path injects `nodeId: getNodeId()`.
- `packages/scheduler-core/src/ports/schedule-manager.port.ts:93` (`CreateScheduleInput`, already has `nodeId`).
- Recall the operator knowledge hub first (`infrastructure` domain): *"How a node builds its first
  scheduled feature"*, *"NodeTask schedule dispatch proven live on candidate-a"*, *"Node Temporal
  tenant interface for recurring work"* (cite, don't re-author).

## Current State (facts)

- **#1741 MERGED** (route→`NodeTaskWorkflow` adapter, `CreateScheduleInput.nodeId`, route SSRF
  guard, `nodeTaskScope`, `validateGrantForScope`, the `ExecutionGrant` mint — all on main; **reuse**).
- **Not started.** No code written for 5035. Branch `derekg1729/task-5035-node-targetable-cron`
  was not cut (a git-lock + uncommitted design-doc edit blocked the checkout). Branch from `origin/main`.
- The worktree is on `derekg1729/node-temporal-tenant-interface` with the design-doc MVP-vs-vFuture
  edits **uncommitted** — those are the authoritative spec section; preserve/commit them.
- Investigation finding: the `nodeId` *plumbing* exists (`CreateScheduleInput.nodeId`, row stores it),
  but the **grant scope still binds to the operator's ctor `nodeId`** (adapter:133) — that, plus the
  data-plane resolver being shared-token, are why it's operator-only today.

## Design / Implementation Target

1. **Grant scope from the validated nodeId, not the ctor pin.** adapter:133 →
   `nodeTaskScope(input.nodeId, route)`; drop the `private readonly nodeId` ctor pin (the route
   layer supplies `nodeId`). The user path keeps `nodeId = getNodeId()`.
2. **Node-authed create seam (control plane).** New internal route that authenticates the caller's
   **`cogni_ag_sk_` agent key** and derives `nodeId` from that authenticated node identity — beacon
   registers its campaign schedules with it. Add `ownerRef` (opaque, beacon's campaign id) to the
   contract. `SINGLE_INPUT_CONTRACT` — seam beacon consumes: `{ nodeId(from auth), route|graphId,
   cron, timezone, payload, ownerRef } → { scheduleId }`.
3. **Per-node dispatch credential (data plane) — GATED on the R1/R2 decision.** Switch the worker
   resolver to `createFailClosedNodePrincipalResolver` backed by a per-node credential store (ESO).
   Do **not** wire shared-token. **Block on the manager's R1 vs R2 call before building this leg.**
4. **Abandon the #1741 proof scaffolding:** remove `nodes/operator/app/src/app/(app)/schedules/view.tsx`
   NodeTask UI toggle + `nodes/operator/app/src/app/api/internal/ops/node-task-echo/route.ts`.
5. **Reuse (do NOT fork):** `NodeTaskWorkflow`, `dispatchNodeTaskActivity`, `nodeTaskScope`,
   `validateGrantForScope`, the route SSRF guard, the `ExecutionGrant` the adapter mints.
6. **Do NOT build (vFuture F2):** per-node namespaces, OpenFGA `can_schedule`, provisioning Temporal
   *into* beacon, the declarative repo-spec reconcile loop, grant↔node hardening beyond shipped.
7. **SPECS_ARE_AS_BUILT — ONE PR:** reconcile `temporal-patterns.md` + `node-baas-architecture.md`
   with the as-built auth model; keep `TENANT_PRINCIPAL_FAIL_CLOSED`.
8. **Boundaries / must-not-regress:** devops freeze (typed `.ts`, no deploy bash); secrets via ESO,
   never `.env` plaintext, never the shared token for the tenant path; the operator models neither
   beacon's users nor its campaigns (dumb trigger).

## Next Actions / Risks

- [ ] **Get the R1 vs R2 decision from the manager** before building the data-plane credential leg
      (Requirement 3). This is the only hard blocker — a human/manager decision, not an agent call.
- [ ] Branch from `origin/main`; claim is held (task.5035) — re-heartbeat. Commit the design-doc
      MVP-vs-vFuture section.
- [ ] Land Requirements 1, 2, 4 (scope fix + agent-key create seam + abandon scaffolding) — these
      are unblocked and tractable now.
- [ ] CI gotchas this lineage hits every time: doc-headers (`Purpose` sentence; `Scope` contains
      "not"; `Invariants` ≤3 bullets ≤140 chars, no `;`-cramming), valid RFC UUIDs in fixtures
      (`…-4xxx-8xxx-…`), `biome check --write`, `arch:check` (service-db imports need a
      `.dependency-cruiser.cjs` allowlist entry), typecheck. Run them locally before `push --no-verify`.
- [ ] Risk: the control plane authenticates the agent key → node; ensure an agent key for node A
      cannot create a schedule with `nodeId = B`. `rbac-expert` is the required reviewer.
- [ ] Risk: ESO-backed per-node dispatch token is real infra — scope it to MVP (one beacon token),
      do not generalize to all nodes speculatively (MVP-stage discipline).
