---
id: knowledge-contribution-api
type: design
title: "Knowledge Contribution API — HTTP wrapper for Dolt knowledge branches"
status: draft
spec_refs:
  - knowledge-data-plane-spec
  - agent-contributor-protocol
work_items:
  - task.0425
  - task.5054
created: 2026-04-29
---

# Knowledge Contribution API — HTTP wrapper for Dolt knowledge branches

> This document owns the API, data model, and package boundaries for the
> reviewable knowledge contribution workflow. The human model, invariants, and
> acceptance criteria live in
> [knowledge-branch-workflow](./knowledge-branch-workflow.md).

## Context

`docs/spec/knowledge-data-plane.md` defines `KnowledgeClass: experimental` and
"knowledge moves upward by explicit promotion only" but originally scoped the
store to a single `main` branch. The workflow design now lifts that restriction
for the **external contribution path only** while keeping internal
`core__knowledge_write` on trunk.

PR #1130 (`task.0424`) shipped the doltgres-on-operator scaffold (drizzle schema package, drizzle-kit migrator, `sql.unsafe + escapeValue` pattern, `AUTO_COMMIT_ON_WRITE`). This design reuses that scaffold and adds:

1. The `knowledge` table to operator (parity with poly — `KNOWLEDGE_TABLE_ON_EVERY_NODE`).
2. Branch ops on the Doltgres knowledge adapter.
3. A shared contribution service in `@cogni/knowledge-store` with per-node thin
   route wrappers.
4. A small attribution index from Cogni principals to Dolt commit hashes.

## Scope

This API lets external agents and less-trusted automation:

- Open a short-lived `contrib/*` branch through HTTP.
- Append multiple logical commit batches to that branch.
- Insert, update, or deprecate `knowledge` rows through typed edit contracts.
- Read the contribution record, commit timeline, and Dolt-backed review diff.
- Close their own open branch.

Session users can merge reviewed branches to `main`. Internal trusted writes
still use `core__knowledge_write` directly on `main`.

The same contract is mounted by every knowledge-capable node. Node apps provide
auth/session resolution and container wiring; the reusable behavior lives in
`@cogni/knowledge-store` and `@cogni/node-contracts`.

## Non-Goals In This API

The workflow-level non-goals are owned by
[knowledge-branch-workflow](./knowledge-branch-workflow.md#pareto-mvp). This API
specifically does not add:

- Web UI for diff review.
- Dolt remote management.
- Branch browsing or rebase endpoints.
- Review comments.
- Real RBAC tables / per-user knowledge RLS.
- Cross-node fan-out (one contribution targets one node).
- MCP tool for knowledge contribution (HTTP only in v0).
- Confidence promotion ladder beyond `30 → operator-set value on merge`.

## Considered & rejected: staging-table alternative

A `knowledge_pending` table on `main` would solve v0 with less complexity: POST writes a row, GET diff is a SELECT, merge is `INSERT ... SELECT`-then-DELETE-then-`dolt_commit`. No `dolt_checkout`, no session-state, no mutex.

**Rejected** because:

- `dolt_diff` gives row-level structural diff for free; staging-table needs hand-rolled diff
- v1 wants UI rendering proper Dolt commit history; staging-table would be torn out and replaced wholesale
- The branch model is the _natural_ Dolt primitive for "PR" — staging-table is a workaround for not having branches

The branching cost is paid once in the adapter. Staging-table code would
recreate the diff/review surface Dolt already exposes.

## Architecture

### Shared service, per-node route bindings

```
┌──────────────────────────────────────────────────────────────────────┐
│ @cogni/knowledge-store (SHARED — cross-node infrastructure)          │
│                                                                       │
│ port/                                                                 │
│   contribution.port.ts          KnowledgeContributionPort            │
│ adapters/doltgres/                                                    │
│   contribution-adapter.ts       DoltgresKnowledgeContributionAdapter │
│ service/                                                              │
│   contribution-service.ts       createContributionService(deps)      │
│ domain/                                                               │
│   contribution.schema.ts        edit + record + commit schemas        │
└──────────────────────────────┬───────────────────────────────────────┘
                               │
                               │ service exposes framework-agnostic
                               │ typed handlers:
                               │   create, appendCommit
                               │   list, getById, listCommits
                               │   diff, merge, close
                               ▼
┌──────────────────────────────────────────────────────────────────────┐
│ nodes/{poly,operator}/app/src/app/api/v1/knowledge/contributions/    │
│                                                                       │
│ route.ts                  ~10 lines: POST/GET wrapper                 │
│ [id]/route.ts             GET wrapper                                 │
│ [id]/commits/route.ts     POST/GET wrapper                            │
│ [id]/diff/route.ts        GET wrapper                                 │
│ [id]/merge/route.ts       POST wrapper                                │
│ [id]/close/route.ts       POST wrapper                                │
│                                                                       │
│ Each wrapper:                                                         │
│   1. Parse body with Zod contract from @cogni/node-contracts          │
│   2. Resolve principal via getSessionUser (Bearer or session)        │
│   3. Call service.<op>({ principal, ... })                            │
│   4. Map service errors → HTTP status + body                          │
└──────────────────────────────────────────────────────────────────────┘
```

**No HTTP framework leaks into `@cogni/knowledge-store`.** The service exports plain async functions taking `{ principal: Principal, ... }` and returning typed records or throwing typed errors. Per-node `route.ts` files do the Next-specific binding. This is the same shape #1130 used for `WorkItemQueryPort` + per-node routes — extended to the cross-node case.

### Where `knowledge` schema lives

- **Generic shape** (id, domain, title, content, tags, ...) lives in
  `nodes/node-template/packages/knowledge/src/schema.ts`, so a fresh node forks
  the same knowledge hub baseline.
- **Operator schema** re-exports the node-template knowledge tables and owns only
  operator-local contribution metadata tables.
- **Per-node companion tables** (e.g. `poly_market_categories`) stay node-private — that's the entire reason node-local schema packages exist.

### Branch lifecycle

```
POST /contributions
  reserve connection
  -> checkout -b contrib/<principal>-<id> from main
  -> optionally apply first edit batch using the same edit helper as append
  -> dolt_commit(message) if edits supplied
  -> checkout main
  -> insert contribution metadata
  -> commit metadata

POST /contributions/:id/commits
  reserve connection
  -> verify contribution is open and principal owns it
  -> serialize append for this contribution in-process
  -> verify branch head still equals recorded head
  -> checkout existing branch
  -> validate targets on branch HEAD
  -> apply typed edit batch
  -> dolt_commit(message)
  -> checkout main
  -> update head_commit + commit_count with optimistic guard
  -> insert contribution commit pointer for the claimed seq
  -> commit metadata

GET /contributions/:id/diff
  -> read Dolt diff from base_commit to recorded head_commit
  -> project row diff to stable JSON

POST /contributions/:id/merge
  reserve connection
  -> checkout main
  -> dolt_merge(branch)
  -> update contribution state
  -> commit metadata
  -> delete/force-delete branch after successful state update

POST /contributions/:id/close
  reserve connection
  -> checkout main
  -> update contribution state
  -> commit metadata
  -> delete/force-delete branch after successful state update
```

### Why metadata exists

Dolt owns history. Cogni metadata exists only for app-level facts Dolt does not
know:

- which authenticated principal opened a contribution;
- which principal authored each HTTP append request;
- whether an app-level contribution is open, merged, or closed;
- idempotency and quota enforcement;
- which Dolt commit hashes belong to the contribution timeline.

Do not use these tables to answer questions Dolt can answer from the commit
graph. Use Dolt for branch heads, diffs, merge behavior, and row history.

### Metadata tables on `main`

```sql
CREATE TABLE knowledge_contributions (
  id              text PRIMARY KEY,
  branch          text NOT NULL,
  state           text NOT NULL,
  principal_id    text NOT NULL,
  principal_kind  text NOT NULL,
  message         text NOT NULL,
  base_commit     text NOT NULL,
  head_commit     text,
  commit_count    integer NOT NULL DEFAULT 0,
  merged_commit   text,
  closed_reason   text,
  idempotency_key text,
  confidence_pct  integer NOT NULL DEFAULT 40,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     text
);

CREATE TABLE knowledge_contribution_commits (
  contribution_id text NOT NULL,
  seq             integer NOT NULL,
  commit_hash     text NOT NULL,
  principal_id    text NOT NULL,
  principal_kind  text NOT NULL,
  auth_source     text NOT NULL,
  message         text NOT NULL,
  edit_count      integer NOT NULL,
  source_ref      text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (contribution_id, seq)
);

CREATE INDEX ON knowledge_contributions (state);
CREATE INDEX ON knowledge_contributions (principal_id, state);
CREATE INDEX ON knowledge_contribution_commits (commit_hash);
CREATE UNIQUE INDEX ON knowledge_contributions (principal_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
```

`head_commit` replaces the old one-shot `commit_hash`. During migration,
existing `commit_hash` values can backfill both `head_commit` and seq `1` rows.
Do not keep `commit_hash` as a permanent public field once the v1 contract is
updated.

### Edit contract

Each append call accepts a typed edit batch:

```typescript
type KnowledgeEntryInput = {
  id?: string;
  domain: string;
  entityId?: string;
  title: string;
  content: string;
  entryType?: string;
  tags?: string[];
  confidencePct?: number;
};

type KnowledgeContributionEdit =
  | { op: "insert"; entry: KnowledgeEntryInput }
  | { op: "update"; targetRowId: string; entry: KnowledgeEntryInput }
  | { op: "deprecate"; targetRowId: string; reason: string };
```

`targetRowId` is evaluated on the contribution branch after checkout, not on
`main`. That allows commit 2 to update a row created by commit 1 on the same
branch. A missing update/deprecate target fails before `dolt_commit`.

`insert.entry.id` is optional but recommended whenever a contributor expects to
refer to the inserted row in a later commit. If omitted, the server generates a
stable row ID for the branch write; clients discover it through `GET /diff`.
The append response stays commit-oriented in v0 instead of returning a per-edit
mutation result.

For attribution, the adapter stamps contributed row writes with
`source_type='external'`, `source_ref='contribution:<id>:<seq>'`, and
`source_node=<principal_id>` when the schema supports it. The commit metadata
row then links that source reference to the final Dolt commit hash and
principal. In v0, this source pointer is edit attribution for the latest branch
write. Full evidence provenance continues to live in knowledge content/citations
and Dolt history; do not infer that a source pointer alone is the cited evidence.

### Branch reads and diff

`GET /:id/diff` must use Dolt diff data. The stable v0 implementation uses
`DOLT_DIFF(base_commit, head_commit ?? base_commit, 'knowledge')`, so review is
anchored to the contribution's fork point and does not drift when `main`
advances. A future adapter may switch to a native three-dot branch diff if
Doltgres support is verified, but the HTTP contract must not change.

Branch-local validation and append writes use reserved-connection checkout. A
future read-only endpoint may use `AS OF '<branch>'` if Doltgres support is
verified, but this is not required for the Pareto MVP.

### Connection pinning

`postgres.js` is a connection **pool**. `sql.unsafe('dolt_checkout(...)')` followed by `sql.unsafe('INSERT...')` may land on different physical connections — checkout would apply to a connection that the next call doesn't use. A process-level mutex doesn't fix this.

**Correct pattern:** every branch op runs inside a single `await sql.reserve(async (conn) => { ... })`. The reserved connection is pinned for the closure's duration; checkout + insert + commit + checkout-back all execute on it. On exception, `try/finally` restores `dolt_checkout('main')` before releasing.

```typescript
async appendCommit(input) {
  return await this.sql.reserve(async (conn) => {
    try {
      await conn.unsafe(`SELECT dolt_checkout('${esc(branch)}')`);
      for (const edit of input.edits) {
        await applyContributionEdit(conn, edit);
      }
      await conn.unsafe(`SELECT dolt_commit('-Am', '${esc(message)}')`);
      const [{ hash }] = await conn.unsafe(`SELECT dolt_hashof('${esc(branch)}') AS hash`);
      await conn.unsafe(`SELECT dolt_checkout('main')`);
      await conn.unsafe(`UPDATE knowledge_contributions SET head_commit = ..., commit_count = ...`);
      await conn.unsafe(`INSERT INTO knowledge_contribution_commits (...) VALUES (...)`);
      await conn.unsafe(`SELECT dolt_commit('-Am', 'contrib-meta: ${esc(id)}:${seq}')`);
      return commitRecord;
    } finally {
      try { await conn.unsafe(`SELECT dolt_checkout('main')`); } catch { /* swallow */ }
    }
  });
}
```

Connection pinning and append ordering are separate concerns. The reserved
connection keeps Dolt checkout state coherent for one operation. Append ordering
also needs a per-contribution critical section and an optimistic metadata guard:

1. serialize appends for the same contribution inside the current process;
2. read `base_commit`, `head_commit`, and `commit_count`;
3. checkout the contribution branch and verify its Dolt head equals
   `head_commit ?? base_commit`;
4. apply edits and commit;
5. update `knowledge_contributions` only where both `commit_count` and
   `head_commit` still match the values read before the append;
6. insert `knowledge_contribution_commits(contribution_id, seq, ...)`.

If the guard fails, return `409 Conflict`. Do not silently create a second row
with the same `seq`, and do not claim a commit in metadata unless the guarded
head update succeeded.

## Contracts

`packages/node-contracts/src/knowledge.contributions.v1.contract.ts` — HTTP request/response wrappers; reuses domain types from `@cogni/knowledge-store`:

```typescript
import { z } from "zod";
import {
  ContributionRecord,
  KnowledgeContributionEdit,
  KnowledgeEntryInput,
} from "@cogni/knowledge-store";

export const ContributionsCreateRequest = z.object({
  message: z.string().min(1).max(512),
  edits: z.array(KnowledgeContributionEdit).min(1).max(50).optional(),
  idempotencyKey: z.string().min(8).max(64).optional(),
});

export const ContributionAppendCommitRequest = z.object({
  message: z.string().min(1).max(512),
  edits: z.array(KnowledgeContributionEdit).min(1).max(50),
});

export const ContributionsListQuery = z.object({
  state: z.enum(["open", "merged", "closed", "all"]).default("open"),
  principalId: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export const ContributionMergeRequest = z.object({
  confidencePct: z.number().int().min(30).max(95).optional(),
});

export const ContributionCloseRequest = z.object({
  reason: z.string().min(1).max(512),
});
```

`packages/knowledge-store/src/domain/contribution.schema.ts`:

```typescript
export const KnowledgeEntryInput = z.object({
  id: z.string().min(1).max(256).optional(),
  domain: z.string().min(1).max(64),
  entityId: z.string().max(128).optional(),
  title: z.string().min(1).max(256),
  content: z.string().min(1).max(65536),
  entryType: z.string().min(1).max(64).optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  confidencePct: z.number().int().min(0).max(100).optional(),
});

export const KnowledgeContributionEdit = z.discriminatedUnion("op", [
  z.object({ op: z.literal("insert"), entry: KnowledgeEntryInput }),
  z.object({
    op: z.literal("update"),
    targetRowId: z.string().min(1).max(256),
    entry: KnowledgeEntryInput,
  }),
  z.object({
    op: z.literal("deprecate"),
    targetRowId: z.string().min(1).max(256),
    reason: z.string().min(1).max(512),
  }),
]);

export const ContributionRecord = z.object({
  contributionId: z.string(),
  branch: z.string(),
  baseCommit: z.string(),
  headCommit: z.string().nullable(),
  commitCount: z.number().int(),
  state: z.enum(["open", "merged", "closed"]),
  principalKind: z.enum(["agent", "user"]),
  principalId: z.string(),
  message: z.string(),
  createdAt: z.string(),
  resolvedAt: z.string().nullable(),
  closedReason: z.string().nullable(),
});

export const ContributionCommitRecord = z.object({
  contributionId: z.string(),
  seq: z.number().int(),
  commitHash: z.string(),
  principalKind: z.enum(["agent", "user"]),
  principalId: z.string(),
  authSource: z.enum(["bearer", "session"]),
  message: z.string(),
  editCount: z.number().int(),
  sourceRef: z.string(),
  createdAt: z.string(),
});

export const ContributionDiffEntry = z.object({
  changeType: z.enum(["added", "modified", "removed"]),
  rowId: z.string(),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
});
```

`targetRowId` belongs to update/deprecate edits, not the base entry shape. That
keeps insertion simple and makes branch-local update semantics explicit.

## Port

`packages/knowledge-store/src/port/contribution.port.ts`:

```typescript
export interface KnowledgeContributionPort {
  create(input: {
    principal: Principal;
    message: string;
    edits?: KnowledgeContributionEdit[];
    idempotencyKey?: string;
  }): Promise<ContributionRecord>;

  appendCommit(input: {
    contributionId: string;
    principal: Principal;
    edits: KnowledgeContributionEdit[];
    message: string;
  }): Promise<ContributionCommitRecord>;

  list(query: {
    state: "open" | "merged" | "closed" | "all";
    principalId?: string;
    limit: number;
  }): Promise<ContributionRecord[]>;

  getById(contributionId: string): Promise<ContributionRecord | null>;

  listCommits(contributionId: string): Promise<ContributionCommitRecord[]>;

  diff(contributionId: string): Promise<ContributionDiffEntry[]>;

  merge(input: {
    contributionId: string;
    principal: Principal;
    confidencePct?: number;
  }): Promise<{ commitHash: string }>;

  close(input: {
    contributionId: string;
    principal: Principal;
    reason: string;
  }): Promise<void>;
}

export class ContributionConflictError extends Error {}
export class ContributionNotFoundError extends Error {}
export class ContributionStateError extends Error {}
export class ContributionQuotaError extends Error {}
export class ContributionForbiddenError extends Error {}
```

## Service factory (cross-node shared)

`packages/knowledge-store/src/service/contribution-service.ts`:

```typescript
export interface ContributionServiceDeps {
  port: KnowledgeContributionPort;
  canMergeKnowledge: (p: Principal) => boolean;
  rateLimit: { maxOpenPerPrincipal: number };
}

export function createContributionService(deps: ContributionServiceDeps) {
  return {
    async create({ principal, body }) {
      if (body.idempotencyKey) {
        const existing = await deps.port.list({
          state: "all",
          principalId: principal.id,
          limit: 100,
        });
        const hit = existing.find(
          (r) => r.idempotencyKey === body.idempotencyKey
        );
        if (hit) return hit;
      }
      const open = await deps.port.list({
        state: "open",
        principalId: principal.id,
        limit: 100,
      });
      if (open.length >= deps.rateLimit.maxOpenPerPrincipal) {
        throw new ContributionQuotaError(
          `max open contributions = ${deps.rateLimit.maxOpenPerPrincipal}`
        );
      }
      return deps.port.create({
        principal,
        message: body.message,
        edits: body.edits,
        idempotencyKey: body.idempotencyKey,
      });
    },
    async appendCommit({ principal, contributionId, body }) {
      const record = await deps.port.getById(contributionId);
      if (!record) throw new ContributionNotFoundError(contributionId);
      if (record.state !== "open") throw new ContributionStateError();
      if (
        record.principalId !== principal.id ||
        record.principalKind !== principal.kind
      ) {
        throw new ContributionForbiddenError();
      }
      return deps.port.appendCommit({
        principal,
        contributionId,
        message: body.message,
        edits: body.edits,
      });
    },
    async merge({ principal, contributionId, confidencePct }) {
      if (!deps.canMergeKnowledge(principal))
        throw new ContributionForbiddenError();
      return deps.port.merge({ contributionId, principal, confidencePct });
    },
    async close({ principal, contributionId, reason }) {
      const record = await deps.port.getById(contributionId);
      const ownsContribution =
        record?.principalId === principal.id &&
        record?.principalKind === principal.kind;
      if (!ownsContribution && !deps.canMergeKnowledge(principal))
        throw new ContributionForbiddenError();
      return deps.port.close({ contributionId, principal, reason });
    },
    list: deps.port.list,
    getById: deps.port.getById,
    listCommits: deps.port.listCommits,
    diff: deps.port.diff,
  };
}
```

Per-node `bootstrap/container.ts` constructs the service once with the node's port + the shared `canMergeKnowledge` policy. Per-node `route.ts` files are then ~10-line Next adapters.

## Auth

Reuses `getSessionUser` resolver from #1130 (Bearer or session). v0 merge gate:

```typescript
export function canMergeKnowledge(p: Principal): boolean {
  return p.kind === "user";
}
```

**No env-var allowlist in v0.** Either you're a signed-in user with a session cookie, or you can't merge. v1 = `knowledge_merge_grants` table on operator DB with audit trail. Documented in spec as `KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION` invariant.

Close is less privileged than merge: the principal that opened a contribution may close its own open branch, and a session user that can merge may close any branch. This lets external agents clean up superseded edits without granting trunk write authority.

Append is owner-only while the contribution is open. v0 intentionally does not
support shared branches or reviewer-authored fixup commits; that would require a
clearer attribution and review policy.

## Rate limit / abuse

| Limit                            | Value | Enforcement                                            |
| -------------------------------- | ----- | ------------------------------------------------------ |
| Open contributions per principal | 10    | Service `create` checks before port call               |
| Edits per commit                 | 50    | Zod contract                                           |
| Bytes per `content` field        | 65536 | Zod contract                                           |
| Bytes per request total          | 64KB  | Next route handler `request.body.size` check           |
| Idempotency-Key TTL              | 24h   | Unique partial index `(principal_id, idempotency_key)` |

429 on quota; 413 on body size; 200 with existing record on idempotency-key replay.

## Spec edits (deferred to implementation PR)

`docs/spec/knowledge-data-plane.md`:

1. **Non-Goals** — replace "Branching, remotes, or cross-node sharing — single branch (`main`) only" with "Dolt remotes, long-lived personal branches, rebase UI, review threads, and cross-node fan-out."
2. **Invariants** — add:
   - `EXTERNAL_CONTRIB_VIA_BRANCH` — external-agent writes to `knowledge` go through `contrib/<agent>-<id>` branches; only session principals merge to `main`
   - `KNOWLEDGE_TABLE_ON_EVERY_NODE` — every knowledge-database node has the `knowledge` table
   - `INTERNAL_WRITES_TO_MAIN` — `core__knowledge_write` (agent runtime) writes straight to `main`; branching is the external-only path
   - `CONTRIBUTION_METADATA_ON_MAIN` — contribution state and app-auth attribution pointers live in `knowledge_contributions` / `knowledge_contribution_commits` on main
   - `KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION` — v0 merge gate is session only; branch owners can close their own open contributions
   - `ATTRIBUTION_INDEX_ONLY` — contribution metadata points at Dolt commit hashes and does not replace Dolt history

## Open Questions

| Q                                                                                             | Status                                                                                                                                             |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Should review diff use `main...branch` or `main, branch` in the current Doltgres build?       | Prefer three-dot PR semantics; component test decides the adapter implementation.                                                                  |
| Does `sql.reserve()` pin reliably across `unsafe()` calls on our postgres.js + Doltgres pair? | Per postgres.js v3 docs yes; component-test confirmation against Doltgres required.                                                                |
| Should `merge` require explicit confidence promotion or default-passthrough?                  | Default-passthrough in v0; required in v1 once flow is exercised.                                                                                  |
| Do append guards need a cross-process DB advisory lock?                                       | v0 uses in-process serialization plus branch-head/metadata guards; component race test decides whether this is enough for one operator deployment. |
| Branch-namespace GC for stale `contrib/*` branches — manual `/close-stale`, or 30-day cron?   | v0 = no GC; quota caps the worst case; v1 work item.                                                                                               |
| Can read-only branch views use `AS OF '<branch>'`?                                            | Non-gating; reserved-connection checkout is sufficient for append validation in the MVP.                                                           |

## Test surface

- **Unit** (`@cogni/knowledge-store`) — service factory: quota, owner-only append/close, session-only merge, contract Zod parse round-trips.
- **Component** (testcontainer Doltgres) — adapter `create → appendCommit ×3 → listCommits → diff → merge`; branch-local update target created by an earlier commit; merge conflict maps to `ContributionConflictError`; close drops branch + writes metadata; reserved-conn restores `main` on error.
- **Stack** (operator app + Doltgres) — `/api/v1/agent/register` bearer creates and appends; bearer merge rejected; session merge accepted; `GET /commits` returns attribution records.

## Risks

- **Reserved-conn long-held during 50-entry insert** — postgres.js pool may starve under contention; v0 has at most 10 open contribs per principal, low-traffic. v1 concern with pool tuning
- **Connection-state leak on adapter error** — try/finally restores `main`; component test exercises error paths
- **Distributed append race** — process-local serialization prevents ordinary
  same-instance races; `head_commit`/`commit_count` guards reject stale metadata.
  A multi-instance deployment may still need a DB advisory lock or equivalent
  lease before appending to the same contribution branch.
- **Diff mode mismatch** — three-dot diff is review-correct, but current Doltgres table-function restrictions may force two-revision calls. Keep this inside the adapter.
- **Three-way merge on `dolt_merge`** — branch was created from `main` HEAD at create; if `main` advances before merge (concurrent internal writes), merge is three-way. Conflicts on `knowledge.id` return 409 (`ContributionConflictError`); v0 does not implement rebase.
- **Doltgres 0.56 RBAC non-functional** — every connection is superuser; app-layer auth is the _only_ gate. Already accepted per spec's `RUNTIME_URL_IS_SUPERUSER`. Reinforces why merge remains session-only — there is no DB-level enforcement
