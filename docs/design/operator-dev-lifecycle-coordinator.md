---
id: design.operator-dev-lifecycle-coordinator
type: design
title: Operator Dev Lifecycle Coordinator
status: draft
trust: draft
summary: Operator becomes an active driver of agent dev sessions. Webhooks update session state through a Postgres outbox; agents read coordination via heartbeat. Temporal enters only where exact-wake timers earn their keep (validation holds).
owner: derekg1729
created: 2026-05-02
updated: 2026-05-10
tags: [operator, lifecycle, agentic, ci-cd, work-items]
---

# Operator Dev Lifecycle Coordinator

## Outcome

A registered agent claims a Cogni work item, stays reachable through a 30+ minute handshake while the operator updates `nextAction` from real CI / PR / flight signals, and is released when validation holds clear.

## Audit signal (the wedge)

`POST /api/v1/vcs/flight` looks up an active `work_item_sessions` row bound to `(repo_full_name, pr_number)` and **decorates the dispatch log with session context** when present. Missing session → structured warn (`vcs_flight.unmediated`), then dispatch proceeds. **Never 412.** Manual / human flights stay a first-class path.

```ts
// nodes/operator/app/src/app/api/v1/vcs/flight/route.ts
const session = await container.workItemSessions.lookupActiveByPr({
  repoFullName: `${owner}/${repo}`,
  prNumber,
});
if (!session) {
  logRequestWarn(
    ctx.log,
    { repoFullName, prNumber, reason: "no_active_session" },
    "vcs_flight.unmediated"
  );
}
// ... CI gate, dispatch — dispatch log carries `mediated: boolean` + session ids.
```

This is the lever that flips `proj.operator-glue` from red to yellow: the matrix red was about **knowing** who flights what, not about preventing humans from flighting. The signal is the ratio of `mediated:unmediated` dispatches in Loki, not a wall.

Hard enforcement is rejected: blocking manual paths would break Derek's `/promote` and break the escape hatch agents need when sessions go wrong. The session lookup makes the audit trail real; the rest is policy that lives in Loki queries, not in the route.

## Picture

```
   ┌──────────┐                    ┌─── operator ────────────────────────────┐
   │  GitHub  │ ── webhook ──────► │  ingest ──► coordinator_outbox          │
   │          │   (signed)         │                    │                     │
   └──────────┘                    │                    ▼                     │
                                   │              outbox-worker               │
                                   │                    │                     │
                                   │                    ▼                     │
   ┌──────────┐  /heartbeat        │           work_item_sessions             │
   │  agent   │ ─────────────────► │  session-policy ◄──┘                    │
   │ (Claude/ │ ◄── nextAction ─── │       │                                  │
   │  Codex/  │                    │       ▼  (PR2 only)                      │
   │  OpenClaw│                    │  Temporal timer ─► validation hold       │
   └──────────┘                    │                                          │
                                   │  outbox ─► GitHub App ─► PR comment      │
                                   └──────────────────────────────────────────┘
```

Webhook ingest is **synchronous to Postgres only** (`coordinator_outbox`). Everything Temporal-touching lives behind the worker. GHA + per-node deploy branches keep the deploy lease; the operator owns the _validation hold_ on top.

## State

| Table                           | Owns                                                                            | Lifetime        | DB                |
| ------------------------------- | ------------------------------------------------------------------------------- | --------------- | ----------------- |
| `work_item_sessions`            | active claim, deadline, branch, `(repo_full_name, pr_number)`, last CI snapshot | per-claim       | operator Postgres |
| `coordinator_outbox`            | inbound webhook signals + outbound PR comments                                  | until delivered | operator Postgres |
| `candidate_validation_requests` | flight intent + hold deadline (PR2)                                             | per-flight      | operator Postgres |
| `candidate_validation_lanes`    | `(slot, node_target)` mutex (PR2)                                               | indefinite      | operator Postgres |
| Dolt `work_items`               | lifecycle status (`needs_*`, `done`)                                            | source of truth | Doltgres          |

**Cross-DB:** never FK across. Validate Dolt refs through `WorkItemQueryPort`. Identity reuses `users` + `SessionUser.id`; no new agent registry.

### Schema delta (next migration)

Migration `0029_*` against `work_item_sessions`:

- Add `repo_full_name TEXT NULL` (nullable for existing rows; populated by `POST /api/v1/work/items/:id/pr` going forward).
- Add partial unique index `work_item_sessions_one_session_per_pr_idx ON (repo_full_name, pr_number) WHERE status IN ('active','idle') AND repo_full_name IS NOT NULL AND pr_number IS NOT NULL`.

Tiebreaker: the partial unique index is the rule. Two active sessions on the same PR is a contract violation; the second `POST /pr` returns 409 with the existing session's `coordinationId`.

## Webhook → session linkage

Lookup key is `(repo_full_name, pr_number)`. The session persists `repo_full_name` at `POST /pr` time alongside `pr_number`.

`coordinator_outbox` is a **downstream consumer** of the existing webhook pipeline (`nodes/operator/app/src/adapters/server/ingestion/github-webhook.ts` + `@cogni/ingestion-core` `WebhookNormalizer`). Do not add a second HMAC verifier or a parallel route; the ingest route fans out: existing path → `ActivityEvent[]` → attribution; new path → outbox row → coordinator worker. One verify, two consumers.

Worker drains the outbox, looks up exactly one session by `(repo_full_name, pr_number)`, updates `last_event_*` and recomputes `nextAction`. No match = drop (event still reaches attribution; not all PRs are coordinator-owned).

## Hybrid: state-machine vs LLM

Default state-machine. LLM cells are leaves, **cached on input tuple change** (so heartbeat polling does not amplify cost).

| Trigger                                                                | Engine | Why                  |
| ---------------------------------------------------------------------- | ------ | -------------------- |
| `check_run.completed`, `pull_request.*`, heartbeat-stale, hold-expired | state  | structured event     |
| Lane-overlap → dispatch vs queue                                       | state  | set algebra          |
| `nextAction` for known `(work_item_status, session_status, ci_state)`  | state  | string template      |
| "Did _this_ PR comment ask the agent a question?"                      | LLM    | NL ambiguity         |
| Synthesize next-action prose for a stuck session                       | LLM    | NL synthesis         |
| Lifecycle-evidence summary for `/review-implementation`                | LLM    | judgment + synthesis |

## Reach-back

| Substrate                        | When                  | Notes                                                                                            |
| -------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------ |
| Polling (`GET /coordination`)    | always                | reliability baseline; canonical                                                                  |
| GitHub PR comment via GitHub App | session has linked PR | uses existing operator app identity                                                              |
| Claude Code `Monitor`            | future, opt-in        | Claude-only; no Codex / OpenClaw equivalent — do not design the cross-runtime contract around it |
| Signed callback webhooks         | rejected for v0–v1    | fragile across 30+ min handshakes; revisit only when PR-comment delivery proves insufficient     |

## Invariants

- `DOLT_IS_SOURCE_OF_TRUTH` — lifecycle status stays on Dolt; operator persists operational state in Postgres only.
- `BRANCH_HEAD_IS_LEASE` — deploy lock is GHA concurrency + per-node deploy branches. Operator owns the validation hold, not the deploy lease.
- `LANE_ISOLATION` — non-overlapping `node_targets` flight independently.
- `CATALOG_IS_SSOT` — node names come from `infra/catalog/*.yaml`. No `nodes` table.
- `WEBHOOK_INGEST_INDEPENDENT` — webhook 2xx response must not depend on Temporal availability. Outbox is the seam.
- `LLM_LEAF_ONLY` — LLM is invoked at graph leaves and cached on input tuple. Heartbeats never trigger an LLM call by themselves.
- `OPERATOR_FLIGHT_AUDITABLE` — `POST /api/v1/vcs/flight` always emits a structured dispatch log carrying `mediated: boolean` + session ids when present. Unmediated flights are warned but never blocked; the matrix red flips on the _signal_, not on a wall.

## Stale-claim policy

`active` (heartbeat fresh) → `idle` (deadline crossed once; surfaced in `nextAction`) → `stale` (sweeper sets after grace) → `closed` (PR merged / cancelled / superseded).

The operator never silently transitions a Dolt work item on missed heartbeat — it only releases the session claim and lets `/review-implementation` advance the work item through the WorkItem port.

## Roadmap

Sequenced execution and per-PR scope live in **`proj.operator-glue`** (project doc, to be created — currently cited in `work/charters/ENGINEERING.md` as a 0-priority project with no file). This design doc holds contracts and invariants only.

## Out of scope

- Generic workflow engine; new agent identity registry; `nodes` table; cross-DB FK to Dolt.
- Signed arbitrary callback webhooks; Slack / Discord / Matrix adapters.
- Auto-closing Dolt work items on missed heartbeat.
- Cogni-dev local bridge (`task.5025`, abandoned).
- Per-session Temporal workflows in v0 (Postgres outbox + worker is sufficient until validation-hold deadlines need exact-wake).

## Validation

exercise:

1. Agent claims `task.X`, links PR #N in repo R via `POST /pr` (carries `repoFullName`).
2. **Unmediated path**: a second agent (different work item, no session linked to PR #N) posts `POST /api/v1/vcs/flight { prNumber: N }` → 202 dispatched. Loki shows `vcs_flight.unmediated` with `(repoFullName, prNumber, reason=no_active_session)` followed by `vcs_flight.dispatched` with `mediated: false`.
3. **Mediated path**: original agent posts `POST /api/v1/vcs/flight { prNumber: N }` → 202 dispatched. Loki shows `vcs_flight.dispatched` with `mediated: true` + `coordinationId` + `workItemId`.
4. CI runs → `check_run.completed` webhook arrives. Within 10s, `GET /coordination` returns `nextAction` reflecting CI state (`"CI green on PR #N — request flight"` or `"Fix failing job <jobName>"`).
5. Operator restart mid-flight: next webhook still updates session (outbox is durable; worker resumes).
6. (PR2) Two agents flight overlapping `node_targets`; second receives `202 queued` and is unblocked when first posts `validated`.
7. **Definition of Done**: after `/validate-candidate` posts a passing scorecard and the session calls `PATCH /api/v1/work/items/:id { deployVerified: true }`, `GET /api/v1/work/items/:id` returns `deploy_verified: true`. Blocked today by `bug.5005` (PATCH allowlist excludes `deployVerified` for Doltgres-backed items); audit-signal work ships independently, validation is incomplete until both land.

observability:

```
# Wedge exercises on candidate-a first; production query is for steady-state monitoring.
{namespace=~"cogni-(candidate-a|production)",pod=~"operator-node-app-.*"} | json
| event=~"dev_coordination\\..*|coordinator_outbox\\..*|candidate_validation\\..*|vcs_flight\\..*"
```

Every coordination line carries `coordinationId`, `workItemId`, `claimedByUserId`. Validation lines add `prNumber`, `headSha`, `nodeTargets`. Webhook-driven updates add `(repoFullName, prNumber, eventType)`. `vcs_flight.dispatched` always emits with `mediated: boolean` + `(coordinationId, workItemId, claimedByUserId)` nullable; `vcs_flight.unmediated` emits whenever no session is bound.
