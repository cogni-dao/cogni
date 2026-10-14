---
id: design.operator-dev-lifecycle-coordinator
type: design
title: Operator Dev Lifecycle Coordinator
status: draft
trust: draft
summary: Operator control plane for long-lived AI-to-AI dev lifecycle handshakes, work item supervision, candidate validation holds, and lifecycle evidence.
owner: derekg1729
created: 2026-05-02
updated: 2026-05-02
tags: [operator, lifecycle, agentic, ci-cd, work-items]
---

# Operator Dev Lifecycle Coordinator

> Supersession note (2026-06-13): this draft predates the node-ref deploy-plane cutover. `POST /api/v1/vcs/flight` is now the `nodeRef { nodeId, sourceSha }` primitive for externally built node artifacts. PR-number examples below describe the older in-repo candidate-flight path and should not be copied as the REST endpoint contract; see [Development Lifecycle](../spec/development-lifecycle.md) for the current flight split.

## Outcome

Success is when an external agent can claim a Cogni work item, stay reachable through a 30+ minute handshake, request candidate validation, and have the operator track the claim, validation hold, notifications, and evidence without duplicating CI/CD lease ownership.

## Problem

The current system has the right lower-level primitives, but not the durable conversation state above them:

- Work item state lives in operator Doltgres `work_items`, but agent execution around a work item is not first-class.
- `POST /api/v1/vcs/flight` dispatches candidate-flight only after CI is green, but it does not track who requested validation, who owns the validation window, or who should be pinged when the slot frees.
- CI/CD has moved to per-node deploy branches and GitHub Actions concurrency. That is correct for deploy-state serialization, but it is not enough to coordinate a long-running AI agent handshake.
- External agents are variable. The operator must send them exact next actions instead of assuming their prompt contains the Cogni lifecycle.

This is operational data, not knowledge. Store it in operator Postgres. Reference Dolt work items by ID; do not copy lifecycle state out of Dolt.

## Existing Invariants

- `STATUS_COMMAND_MAP`: every `needs_*` status maps to exactly one lifecycle command.
- `VALIDATION_REQUIRED`: every task/bug needs `exercise:` and `observability:` before closeout.
- `SELF_VALIDATE`: candidate deployment is not done until the requester or qa-agent exercises the feature and observes its own signal.
- `DOLT_IS_SOURCE_OF_TRUTH`: work item lifecycle fields remain on Dolt-backed `work_items`.
- `LANE_ISOLATION` + `BRANCH_HEAD_IS_LEASE`: deploy serialization is per `(env, node)` deploy branch plus GHA concurrency. The operator must not reintroduce a competing deploy-branch lease.
- `CATALOG_IS_SSOT`: deployable node names come from `infra/catalog/*.yaml`, not a hand-maintained Postgres `nodes` table.
- `PER_NODE_DEPLOY_SELF_VALIDATES`: a node flight succeeds only when that node's `/version.buildSha` matches its source-sha map entry.

## Implementation Cut

The full coordinator is the right direction, but it is too broad as one implementation. Ship it as composable PRs:

| PR  | Scope                      | Ships                                                                                                                                                          |
| --- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Coordination foundation    | Work-item sessions plus claim/heartbeat/PR-link/status APIs. No lifecycle evidence, outbox, notification sender, or candidate-flight behavior change.          |
| 2   | Candidate validation holds | A new work-item validation policy endpoint, per-node target holds, validation hold extend/release, queued response + notifications. No workflow lease rewrite. |

Everything else is future work: production promotion supervision, full pr-review lifecycle certification, arbitrary callback/webhook identity, Slack/Discord adapters, historical node catalog snapshots, and automatic stale-work-item closure.

## Phased Work Items

Created as Cogni API work items on preview, not markdown files:

- `task.5007` — Operator work-item coordination foundation
- `task.5008` — Candidate validation holds for flight requests
- `task.5009` — Operator notifications and lifecycle review evidence

### 1. Operator Work-Item Coordination Foundation (`task.5007`)

Suggested payload:

```json
{
  "type": "task",
  "title": "Operator work-item coordination foundation",
  "summary": "Add operator-owned work-item sessions and claim/heartbeat/PR-link/status APIs.",
  "outcome": "A registered external agent can claim a Dolt work item, heartbeat for 30+ minutes, link a PR, and read exact next-action instructions without changing candidate flight behavior.",
  "status": "needs_implement",
  "node": "operator",
  "labels": ["operator", "lifecycle", "work-items"],
  "specRefs": ["design.operator-dev-lifecycle-coordinator"]
}
```

Before:

- Work items can be created/read/patched, but there is no first-class active executor for a work item.
- A stalled agent leaves no durable heartbeat/deadline state.
- There is no operational session state that tells another agent who is actively executing the work item.

After:

- `POST /api/v1/work/items/:id/claims` creates one active session per work item.
- `POST /api/v1/work/items/:id/heartbeat` refreshes the session deadline and returns `nextAction`.
- `POST /api/v1/work/items/:id/pr` links branch/PR to the session.
- `GET /api/v1/work/items/:id/coordination` returns active session, deadline, PR, and exact next action text.
- Missed heartbeat can move the session to `idle` or `stale` without mutating Dolt work-item status.

Not included:

- No `/api/v1/vcs/flight` behavior change.
- No candidate validation queue.
- No lifecycle evidence or operator outbox rows.
- No GitHub PR comments or notification sender.
- No new identity or node tables.

### 2. Candidate Validation Holds for Flight Requests (`task.5008`)

Suggested payload:

```json
{
  "type": "task",
  "title": "Candidate validation holds for flight requests",
  "summary": "Broker work-item-linked candidate flight requests through per-node validation holds while preserving existing GitHub Actions deploy leases.",
  "outcome": "When an agent requests flight with a work-item session, the operator resolves affected node targets, queues overlapping validation requests, dispatches non-overlapping flights, starts a default 5-minute validation hold after flight success, and releases or extends the hold through explicit APIs.",
  "status": "needs_implement",
  "node": "operator",
  "labels": ["operator", "ci-cd", "candidate-a"],
  "specRefs": ["design.operator-dev-lifecycle-coordinator"]
}
```

Before:

- `POST /api/v1/vcs/flight` dispatches once CI is green.
- The candidate-flight workflow owns deploy serialization, but no operator state tracks the validation window after successful flight.
- Two agents touching the same node can overwrite the human/agent validation window.

After:

- Existing requests without `workItemSessionId` preserve primitive behavior.
- Requests with `workItemSessionId` create `candidate_validation_requests`.
- Operator resolves node targets from PR files plus catalog mapping.
- Overlapping `(candidate-a, node_target)` validation holds queue; non-overlapping nodes dispatch independently.
- `extend` and `validated` APIs update evidence and release holds.

### 3. Operator Notifications and Lifecycle Review Evidence (`task.5009`)

Suggested payload:

```json
{
  "type": "task",
  "title": "Operator notifications and lifecycle review evidence",
  "summary": "Deliver queued operator notifications and synthesize lifecycle evidence for final review without adding arbitrary callback identity.",
  "outcome": "The operator can notify PR-linked agents when sessions stale, validation starts, validation expires, or a queued flight unblocks, and can summarize lifecycle evidence for final cogni-git-review / review-implementation decisions.",
  "status": "needs_design",
  "node": "operator",
  "labels": ["operator", "notifications", "review"],
  "specRefs": ["design.operator-dev-lifecycle-coordinator"]
}
```

Before:

- Polling is the only durable delivery path.
- Outbox rows may exist but are not delivered externally.
- Final review still has to manually piece together lifecycle evidence.

After:

- Outbox sender can post idempotent GitHub PR comments when a PR is linked.
- Stale sessions and expired holds are swept without waiting for the next user request.
- Review tooling can query lifecycle evidence and report whether CI, candidate flight, exercise, observability, code review, and merge evidence exist.
- Arbitrary signed webhooks remain deferred until the PR-comment path proves useful.

## Target Architecture

Build one operator-local coordinator around work items, agent sessions, candidate validation holds, and notifications.

```text
external agent
  -> POST /api/v1/work/items/:id/claims
       creates agent session, starts heartbeat deadline, returns lifecycle instructions

agent works, opens PR
  -> POST /api/v1/work/items/:id/pr
       links PR to the session and work item

agent requests candidate validation
  -> POST /api/v1/vcs/flight
       records validation request, resolves affected node targets from GitHub PR files + catalog,
       dispatches candidate-flight only when lane policy allows, otherwise queues

candidate-flight workflow
  -> existing per-node deploy branches + GHA concurrency
       deploys and verifies `/version.buildSha` per affected node

operator coordinator
  -> observes terminal candidate-flight status
  -> starts validation hold
  -> pings requester with exact `/validate-candidate` instructions
  -> extends/release hold on explicit API calls or heartbeat timeout
  -> records evidence and advances work item only through the WorkItem port
```

The operator owns **intent, deadlines, notifications, and evidence**. GitHub Actions owns **deploy mutation and per-node serialization**.

## AI-to-AI Handshake

Use both polling and callbacks.

Polling is the reliability baseline. Every state-changing response returns:

- `coordinationId`
- `statusUrl`
- `streamUrl` when SSE is available
- `nextAction`
- `deadlineAt`

Callbacks are acceleration, not correctness. PR 1 and PR 2 should implement polling plus GitHub PR comments only. Do not create a new agent contact registry in the MVP. Later, an agent may register one or more notification endpoints:

- `callback_url`: HTTPS webhook for machine agents.
- `github_pr_comment`: always available once a PR exists.
- later: Slack/Discord/Matrix via a notification adapter.

Webhook delivery, when added, must be signed with an operator HMAC header and retried with exponential backoff. If callback delivery fails, the event remains visible through polling and GitHub PR comments.

All callbacks use the same envelope:

```json
{
  "eventId": "evt_...",
  "eventType": "validation_hold_started",
  "coordinationId": "coord_...",
  "workItemId": "task.0424",
  "prNumber": 1143,
  "nodeTargets": ["operator"],
  "deadlineAt": "2026-05-02T20:15:00Z",
  "nextAction": "Run /validate-candidate for PR #1143, then POST /validated with evidence."
}
```

Events are idempotent by `eventId`. Agents that cannot receive callbacks still poll `statusUrl`.

## State Model

Keep the state model narrow. Do not create a generic workflow engine.

### Tables

PR 1 tables:

`work_item_sessions`

- `id` primary key
- `work_item_id` text, logical reference to Dolt `work_items.id`
- `claimed_by_user_id` references `users(id)`
- `claimed_by_display_name` text nullable snapshot for operator readability
- `status` text: `active | idle | stale | closed | superseded`
- `claimed_at`, `last_heartbeat_at`, `deadline_at`, `closed_at`
- `last_command` text nullable
- `branch` text nullable
- `pr_number` integer nullable
- unique active claim on `(work_item_id)` where `status in ('active', 'idle')`

Deferred tables:

- `lifecycle_evidence`
- `operator_outbox`

Do not add these until there is a proven evidence consumer and a real sender.

PR 2 tables:

`candidate_validation_requests`

- `id` primary key
- `work_item_session_id` references `work_item_sessions(id)`
- `work_item_id` text denormalized for query speed
- `pr_number` integer not null
- `head_sha` text not null
- `status` text: `requested | queued | dispatching | flighting | awaiting_validation | extended | validated | expired | failed | cancelled`
- `workflow_url` text nullable
- `flight_started_at`, `flight_finished_at`, `validation_deadline_at`, `validated_at`

`candidate_validation_targets`

- `validation_request_id` references `candidate_validation_requests(id)`
- `slot` text not null, default `candidate-a`
- `node_target` text not null
- primary key `(validation_request_id, slot, node_target)`

`candidate_validation_lanes`

- `slot` text not null, default `candidate-a`
- `node_target` text not null
- `active_validation_request_id` references `candidate_validation_requests(id)` nullable
- primary key `(slot, node_target)`

The lane table is not a node registry. It is a lock table keyed by catalog slug. Rows are created lazily after validating `node_target` against `infra/catalog/*.yaml`.

### Critically Important Foreign Keys

Use real FKs only inside operator Postgres:

- `work_item_sessions.claimed_by_user_id -> users.id`
- `candidate_validation_requests.work_item_session_id -> work_item_sessions.id`
- `candidate_validation_targets.validation_request_id -> candidate_validation_requests.id`
- `candidate_validation_lanes.active_validation_request_id -> candidate_validation_requests.id`

Do **not** mint a new agent identity in PR 1. `POST /api/v1/agent/register` already creates a `users.id`, a billing account, and a signed machine bearer token. Routes using `getSessionUser` already see bearer-authenticated agents and browser users as the same `SessionUser` shape. The coordinator's session owner identity is `SessionUser.id`. This keeps PR 1 operational and avoids overloading `actor_id`, which the identity model reserves for economic attribution.

Do **not** FK to Doltgres `work_items`. Cross-database FK is not available and would couple hot operational data to the versioned knowledge/work plane. Treat `work_item_id` as a validated external reference: on claim/create, the operator reads Dolt work item through `WorkItemQueryPort`; if missing, reject. Periodic reconciliation finds dangling refs.

Do **not** create a `nodes` table for v0. `node_targets` are catalog slugs resolved from `infra/catalog/*.yaml`. Add a `node_catalog_snapshot` table only if the operator needs historical display of renamed/removed nodes.

### Work Item Role Boundaries

Use the same separation as mature work management systems:

- **Assignee:** durable accountable owner of the work item. This already exists as `WorkItem.assignees` and must remain on the Dolt-backed work item. Do not mirror it into `work_item_sessions`.
- **Active claimant:** transient executor currently driving one operator handshake. This is `work_item_sessions.claimed_by_user_id`. It can be an external registered agent or a human user because both resolve to `SessionUser.id`.
- **Reviewer:** durable review responsibility. This already exists as `WorkItem.reviewer`; PR 1 should read it for next-action text but not replace it.
- **Requester:** event-level initiator, not a durable role. Use this word in API responses when helpful, but do not make it the main database role name.
- **Evidence author:** when evidence exists later, use `created_by_user_id` for provenance. Do not add mutable `last_edited_by` columns across coordinator tables.

This avoids rebuilding Jira/Linear inside the coordinator. Dolt work items own assignment and lifecycle status. Operator Postgres owns active execution sessions and deadlines in Phase 1.

## PR 1 — Coordination Foundation

Outcome: external agents can claim a work item, heartbeat, receive next-action instructions, and link branch/PR metadata without touching candidate flight.

API:

- `POST /api/v1/work/items/:id/claims`
- `POST /api/v1/work/items/:id/heartbeat`
- `POST /api/v1/work/items/:id/pr`
- `GET /api/v1/work/items/:id/coordination`

Behavior:

- Claim validates `work_item_id` through the existing Dolt work-item port.
- Claim uses the authenticated `SessionUser.id` as `claimed_by_user_id`; no separate participant/contact record is created.
- Claim creates `work_item_sessions` with `deadline_at`.
- Heartbeat updates `last_heartbeat_at` and returns `nextAction`.
- PR-link records `branch` and `pr_number` on the active session after checking that the session belongs to the authenticated session owner.
- PR-link also patches the durable work item's `branch` and `pr` fields.
- Status returns the active session, deadline, PR number if known, and next action.

Files:

- Create operator-local Zod contracts under `nodes/operator/app/src/contracts`.
- Create `nodes/operator/app/src/features/work-item-sessions/` for pure policy.
- Create `nodes/operator/app/src/ports/work-item-session.port.ts`.
- Create operator Postgres migration + adapter.
- Add route handlers under work item paths.

Tests:

- Contract/route tests for claim, heartbeat, coordination status.
- Policy tests for stale transition and next-action text.
- Repository tests for active-claim uniqueness and FK behavior.

### Phase 1 Specific Code Plan

Keep Phase 1 to one PR. The code should introduce reusable coordinator building blocks but stop before flighting.

1. Contracts
   - Add `nodes/operator/app/src/contracts/work-item-sessions.v1.contract.ts`.
   - Define Zod schemas for `claim`, `heartbeat`, `prLink`, and `coordinationStatus`.
   - Shared output fields: `coordinationId`, `workItemId`, `status`, `claimedByUserId`, `deadlineAt`, `nextAction`, `prNumber`, and `branch`.
   - Do not export this from shared `@cogni/node-contracts` until another node implements the same API.

2. Schema and migration
   - Add operator-local `workItemSessions` schema under `nodes/operator/app/src/shared/db`.
   - Add `export * from "./work-item-sessions"` to `nodes/operator/app/src/shared/db/schema.ts`.
   - Generate the operator migration under `nodes/operator/app/src/adapters/server/db/migrations`.
   - Required DB constraints:
     - FK `work_item_sessions.claimed_by_user_id -> users.id`.
     - Partial unique index for one active/idle session per `work_item_id`.
   - Enable RLS on the new table, but access it through the injected service DB because coordination state is shared operational data. Auth checks happen before adapter calls.

3. Port and adapter
   - Add `nodes/operator/app/src/ports/work-item-session.port.ts`.
   - Methods: `claim`, `heartbeat`, `linkPr`, `getCurrent`.
   - Add `nodes/operator/app/src/adapters/server/db/work-item-session.adapter.ts`.
   - Adapter uses Drizzle only; no work-item lifecycle decisions, no GitHub calls, no direct session auth.
   - Wire the adapter in `nodes/operator/app/src/bootstrap/container.ts` as `workItemSessions`, passing `serviceDb`.

4. Feature policy and facade
   - Add `nodes/operator/app/src/features/work-item-sessions/` for pure policy:
     - stale/idle transition calculation from `deadlineAt` and current time.
     - `nextAction` text derived from work item status, `lastCommand`, and PR link.
     - claim conflict behavior: return existing active session details plus retry guidance, not a generic 409.
   - Add `nodes/operator/app/src/app/_facades/work/coordination.server.ts`.
   - Facade validates the Dolt work item through existing `getWorkItem` / `doltgresWorkItems` path, calls the coordinator port, and maps domain results to contract DTOs.
   - Facade enforces that heartbeat and PR-link calls belong to the authenticated `claimed_by_user_id`.

5. Routes
   - Add route handlers:
     - `nodes/operator/app/src/app/api/v1/work/items/[id]/claims/route.ts`
     - `nodes/operator/app/src/app/api/v1/work/items/[id]/heartbeat/route.ts`
     - `nodes/operator/app/src/app/api/v1/work/items/[id]/pr/route.ts`
     - `nodes/operator/app/src/app/api/v1/work/items/[id]/coordination/route.ts`
   - Use `wrapRouteHandlerWithLogging` with required auth and `getSessionUser`.
   - Routes parse request bodies with the new contracts and parse outputs before returning.
   - Update `nodes/operator/app/src/app/api/AGENTS.md` public route list.

6. Observability
   - Emit structured events from the facade/feature boundary:
     - `dev_coordination.claimed`
     - `dev_coordination.heartbeat`
     - `dev_coordination.heartbeat_stale`
     - `dev_coordination.pr_linked`
     - `dev_coordination.claim_conflict`
   - Every event includes `coordinationId`, `workItemId`, and `claimedByUserId`.

7. Tests
   - Contract tests for all new Zod operations.
   - Feature policy unit tests for fresh, idle, conflict, PR-linked, and no-PR cases.
   - Route contract tests with mocked container/session, matching existing `work.items.route.test.ts`.
   - Adapter/component tests for active-claim uniqueness and heartbeat ownership path.

PR 1 does **not**:

- Modify `POST /api/v1/vcs/flight`.
- Resolve node targets.
- Dispatch GitHub workflows.
- Close or transition Dolt work items automatically.
- Send arbitrary webhooks.

## PR 2 — Candidate Validation Holds

Outcome: agents can request candidate validation through a work-item policy endpoint and the operator can queue or hold validation by overlapping node targets without changing workflow lease ownership.

API:

- `POST /api/v1/work/items/:id/validation-requests`
- `GET /api/v1/work/items/:id/validation-requests/:requestId`
- `POST /api/v1/work/items/:id/validation-requests/:requestId/extend`
- `POST /api/v1/work/items/:id/validation-requests/:requestId/validated`

Behavior:

- Existing `POST /api/v1/vcs/flight` keeps primitive behavior for backwards compatibility.
- Work-item validation requests enter the policy coordination path and may call the existing flight primitive when allowed.
- Operator resolves `head_sha` using existing `getCiStatus`.
- Operator resolves `node_targets` from GitHub PR files plus catalog mapping. Do not accept caller-provided `nodeTargets` on the production API path; an agent could underdeclare affected nodes and bypass an active hold. If the resolver is not ready, PR 2 is not ready. Test-only overrides may exist behind internal auth.
- In one DB transaction, upsert lane rows for `(candidate-a, node_target)`, lock them with `SELECT ... FOR UPDATE`, then set `active_validation_request_id` if all requested lanes are free.
- If no active hold overlaps `node_targets`, dispatch existing `candidate-flight.yml`.
- If an active hold overlaps, create a queued request and return `202 queued` with `statusUrl`, `position`, `deadlineAt`, and exact next action.
- On flight success observation, transition to `awaiting_validation` and set default 5-minute `validation_deadline_at`.
- `extend` can extend the validation deadline within a bounded max.
- `validated` records exercise/observability evidence and releases the hold.
- Expired holds release automatically when observed by the next request/status call. A background sweeper can come later.

Tests:

- Contract tests for dispatched, queued, extend, validated.
- Policy tests for target overlap.
- Repository tests proving overlapping lane acquisition is serialized.
- Route tests using mocked VCS capability.
- No E2E workflow rewrite in this PR.

PR 2 does **not**:

- Modify the primitive `/api/v1/vcs/flight` contract.
- Remove GHA concurrency.
- Add a new deploy lease file.
- Build a long-running controller.
- Track preview or production promotion.
- Certify the whole lifecycle in pr-review.

## Candidate Flight Lease Rationalization

Do not purge workflow concurrency. Keep it as the physical deploy lock.

Current CI/CD says per-node branch heads plus GHA concurrency are the lease. That is the right layer for deploy mutation:

- `candidate-flight.yml` decides affected nodes.
- Each matrix cell writes only `deploy/candidate-a-<node>`.
- GHA concurrency serializes the same `(env, node)` lane.
- `/version.buildSha` verifies that node's deployed artifact.

The operator coordinator adds a **validation hold**, not a deploy lease.

```text
deploy lock:        owned by GHA + deploy branches, lasts until workflow terminal
validation hold:   owned by operator Postgres, starts after flight success, lasts while agent validates
```

When a second agent requests flight:

- If its `node_targets` do not overlap any active validation hold, dispatch immediately.
- If targets overlap a hold, record `queued` and notify the requester.
- When the hold is validated or expires, dispatch the next queued request whose targets are unblocked.

This preserves node-independent flighting. Operator can fly PR A for `poly` while PR B validates `operator`, because their node target sets do not overlap.

## Work Item Supervision

The same coordinator should track the whole development session, not just flighting.

Claiming a work item creates `work_item_sessions` with a heartbeat deadline. Every operator response includes the current lifecycle command and expected next API call.

Stale policy:

- `active`: agent heartbeat is fresh.
- `idle`: deadline passed once; surfaced through coordination status and next-action text.
- `stale`: future sweeper/sender state after a grace window.
- `closed`: PR merged, cancelled, or superseded.

The operator does not silently close Dolt work items on the first missed heartbeat. It releases the session claim and records evidence. It only transitions the work item through the WorkItem port when lifecycle rules allow it:

- no PR and no heartbeat: release claim; item remains in its current `needs_*` state.
- PR open and session stale: future sender may comment on PR and mark session `stale`.
- validation hold expired: mark validation request `expired`, ping requester, dispatch next queued compatible request.
- review passed and PR merged: lifecycle evidence records merge; work item may move to `done` only through `/review-implementation` or the corresponding operator policy path.

## Final API Surface

Keep external API small:

- `POST /api/v1/work/items/:id/claims`
- `POST /api/v1/work/items/:id/heartbeat`
- `POST /api/v1/work/items/:id/pr`
- `GET /api/v1/work/items/:id/coordination`
- `POST /api/v1/work/items/:id/validation-requests`
- `GET /api/v1/work/items/:id/validation-requests/:requestId`
- `POST /api/v1/work/items/:id/validation-requests/:requestId/extend`
- `POST /api/v1/work/items/:id/validation-requests/:requestId/validated`

Keep `POST /api/v1/vcs/flight` as the thin CI-green dispatch primitive. The policy endpoint may invoke it later when all validation holds allow dispatch.

## Rejected Alternatives

- **Callbacks only.** Too fragile for 30+ minute handshakes. Agents lose processes, tunnels, and tokens. Polling must remain canonical.
- **Workflow-only queue.** GitHub Actions can serialize deploy mutations, but it cannot own rich agent identity, callback delivery, stale work-item sessions, or lifecycle evidence.
- **New queue service/controller.** More moving parts than needed. Postgres rows plus an outbox worker are enough.
- **Postgres `nodes` table in v0.** Duplicates catalog truth and creates drift before node identity is modeled. Use catalog slugs now.
- **Cross-database FK to Dolt work items.** Not available and the wrong coupling. Validate references through ports and reconcile.
- **Purge GHA concurrency.** That would move deploy correctness into app code. Keep CI/GitOps as the physical lock.

## Deferred Work

Defer until PR 1 and PR 2 are live and exercised:

- A background sweeper for stale sessions and expired validation holds.
- Signed arbitrary callback webhooks.
- Slack/Discord/Matrix notification adapters.
- `node_catalog_snapshot` for historical node rename/remove display.
- pr-review lifecycle certification from `lifecycle_evidence`.
- Preview and production supervision.
- Automatic transition or closure of stale Dolt work items.

## Validation

exercise:

```text
PR 1:
1. Register agent A.
2. Agent A claims a Dolt work item.
3. Agent A heartbeats and receives next action.
4. Agent A links branch/PR metadata.
5. Coordination status returns the active session and next action without changing the Dolt work item status.

PR 2:
1. Agent A links a PR and requests candidate flight for node target operator.
2. Agent B requests candidate flight for an overlapping operator target and receives queued.
3. Agent A reaches awaiting_validation, extends once, then posts validated evidence.
4. Agent B is unblocked on the next status/request observation.
```

observability:

```text
{namespace="cogni-candidate-a"} | json
| event in (
  "dev_coordination.claimed",
  "dev_coordination.heartbeat",
  "dev_coordination.pr_linked",
  "dev_coordination.claim_conflict",
  "candidate_validation.requested",
  "candidate_validation.queued",
  "candidate_validation.hold_started",
  "candidate_validation.extended",
  "candidate_validation.validated"
)
```

expect:

- every coordination log line includes `coordinationId`, `workItemId`, and `claimedByUserId`
- validation logs include `prNumber`, `headSha`, and `nodeTargets`
- final lifecycle evidence includes `exercise` and `observability` entries linked to the validation request once Phase 3 exists
