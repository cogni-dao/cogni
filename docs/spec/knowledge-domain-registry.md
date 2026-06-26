---
id: knowledge-domain-registry-spec
type: spec
title: "Knowledge Domain Registry — FK Enforcement, HTTP API, and Phasing"
status: draft
spec_state: draft
trust: draft
summary: "Makes ENTRY_HAS_DOMAIN a real gate. Every write to `knowledge` (HTTP contributions and `core__knowledge_write`) verifies `domain` exists in `domains` before INSERT; unregistered domains return 400. Base set seeded by the schema migrator (reference data, not content); cookie-session HTTP + UI extends beyond the base. Phased: Phase 1 single-node (operator manages knowledge_operator), Phase 2 registry-node hosts UIs for headless nodes."
read_when: Implementing or reviewing the domain registry, debugging a `DomainNotRegisteredError`, designing a future registry node, or extracting `/knowledge` UI into a shared package.
implements:
owner: derekg1729
created: 2026-05-10
verified:
tags: [knowledge, dolt, domain, registry, fk, syntropy]
---

# Knowledge Domain Registry — FK Enforcement, HTTP API, and Phasing

> Without the registry, `domain` is free text and the knowledge plane silently accumulates entropy. With the registry, every claim is anchored to a registered category.

### Key References

|                    |                                                                             |                                                                                                       |
| ------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **Schema**         | [knowledge-syntropy](./knowledge-syntropy.md) § Seed Schema                 | `domains` table columns                                                                               |
| **Infrastructure** | [knowledge-data-plane](./knowledge-data-plane.md)                           | Doltgres server, per-node DBs, `KnowledgeStorePort`                                                   |
| **Cookie-Session** | [knowledge-syntropy](./knowledge-syntropy.md) § Invariants                  | `DOMAIN_HTTP_COOKIE_ONLY` (domains write/list); knowledge reads → `KNOWLEDGE_READ_REQUIRES_PRINCIPAL` |
| **UI Reference**   | PR #1308 (`task.5037`)                                                      | `/knowledge` Browse ⇄ Inbox toggle, DataGrid, Sheet                                                   |
| **Future Hosting** | [knowledge-syntropy](./knowledge-syntropy.md) § Critical Path § Rd-PORTABLE | UI extraction into `@cogni/...-knowledge-ui` package                                                  |

---

## Goal

Close the gap where `ENTRY_HAS_DOMAIN` was declared as an invariant but not enforced. Make `domain` a foreign key in spirit — every write to `knowledge` verifies the domain is registered, or fails with `DomainNotRegisteredError`. Seed the base set in the schema migration (reference data) and provide a UI to extend beyond it.

---

## Design

### Enforcement Contract

```
INSERT INTO knowledge (..., domain, ...) VALUES (..., $d, ...)
        │
        ▼
  assertDomainRegistered(client, $d)
        │
        ├─ SELECT 1 FROM domains WHERE id = $d LIMIT 1
        │      │
        │      ├─ 0 rows → throw DomainNotRegisteredError
        │      └─ 1 row  → continue
        ▼
  INSERT proceeds
```

Both write paths share one helper. The check lives **in the Doltgres adapters**, not in the capability layer:

| Path                                        | Where the check fires                                                                                                                                  |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core__knowledge_write` tool                | `DoltgresKnowledgeStoreAdapter.{add,upsert,update}Knowledge` calls helper on `this.sql` (main)                                                         |
| HTTP `POST /api/v1/knowledge/contributions` | `DoltgresKnowledgeContributionAdapter` calls helper on the per-PR branch's reserved connection, inside `applyEdit`, just before the `knowledge` INSERT |

**Why adapter-level, not capability-level:** the capability layer (`createKnowledgeCapability`) stays a thin auto-commit wrapper, unmodified. Putting the check in adapters means it covers every port consumer — including future ones — without re-wiring.

**Why the contribution path checks on the per-PR branch (not on `main`):** the helper accepts `Sql | ReservedSql` so it can run inside a reserved-conn / branch scope, and the contribution adapter does exactly that — it calls the check on the reserved branch connection inside `applyEdit`. This is what makes agent-proposed domains work: a single contribution may `register_domain` _and_ `insert` an entry into that new domain. Because the FK check reads the branch's own `domains` table, a domain registered earlier in the same contribution satisfies it. The adapter stable-sorts `register_domain` edits to the front of the batch (`orderEditsForFk`) so the domain row exists on the branch before any entry references it. Genuinely-unregistered domains — ones no edit in the contribution registers — still fail with `DomainNotRegisteredError`.

**Why one helper, not two parallel checks:** the two adapters live in two ports (`KnowledgeStorePort`, `KnowledgeContributionPort`) that don't share inheritance. A shared helper in `packages/knowledge-store/src/adapters/doltgres/util.ts` keeps DRY without coupling the ports.

**SQL safety:** Doltgres requires `sql.unsafe()` + `escapeValue()` (postgres.js extended protocol is broken on Doltgres). The helper must escape `domain` before interpolation. No exceptions.

### Error mapping

| Error class                | HTTP status | Response body                               |
| -------------------------- | ----------- | ------------------------------------------- |
| `DomainNotRegisteredError` | 400         | `{ error: "domain '<id>' not registered" }` |

The `DomainNotRegisteredError` class lives in `packages/knowledge-store/src/port/knowledge-store.port.ts` alongside the port interface. Route handlers (`_handlers.ts`) map it to 400 in their existing typed-error switch.

---

### HTTP API

```
GET  /api/v1/knowledge/domains       cookie-only  →  200 { domains: Domain[] }
POST /api/v1/knowledge/domains       cookie-only  →  201 | 409 | 400
```

### `GET /api/v1/knowledge/domains`

Returns all registered domains with `entry_count`. **Single SQL query** (no N+1):

```sql
SELECT d.id, d.name, d.description, d.created_at, COUNT(k.id) AS entry_count
FROM domains d
LEFT JOIN knowledge k ON k.domain = d.id
GROUP BY d.id, d.name, d.description, d.created_at
ORDER BY d.id;
```

Response shape (Zod contract `packages/node-contracts/src/knowledge.domains.v1.contract.ts`):

```typescript
{
  domains: Array<{
    id: string;
    name: string;
    description: string | null;
    entryCount: number;
    createdAt: string; // ISO timestamp
  }>;
}
```

### `POST /api/v1/knowledge/domains`

Body: `{ id, name, description? }`.

| Outcome                           | Status | Behavior                                                                |
| --------------------------------- | ------ | ----------------------------------------------------------------------- |
| Valid + new id                    | 201    | INSERT + `dolt_commit('-Am', 'register domain <id>')`. Returns the row. |
| Duplicate id                      | 409    | `{ error: "domain '<id>' already registered" }`. No commit.             |
| Invalid input (Zod)               | 400    | Standard contract-validation 400.                                       |
| Not signed in (no session cookie) | 401    | Standard auth 401.                                                      |

DELETE / PUT endpoints are **out of scope** in v0 (per `DEPRECATE_NOT_DELETE` spirit). Domain registration is sticky.

### Auth

The **direct** domain register/list endpoint (`GET` + `POST /api/v1/knowledge/domains`) is cookie-session only (`DOMAIN_HTTP_COOKIE_ONLY`) — it is the trusted-human fast-path. Bearer agents cannot create a domain via that endpoint. They MAY instead **propose** a domain through the existing contribution flow: a `register_domain` edit op (`{ op: 'register_domain', id, name, description? }`) inside a `POST /api/v1/knowledge/contributions` request. The op registers the domain on the agent's `contrib/*` branch; a human approves it on merge, exactly like every other knowledge write. There is **no new RBAC and no new endpoint** — anti-spam relies entirely on the existing gate: the contrib-branch isolation + human-merge requirement + one-open-contribution-per-principal quota (W2.5). Because the same contribution may register a domain and insert entries into it, the adapter applies `register_domain` edits first so the branch FK check passes (see "Why the contribution path checks on the per-PR branch" above).

Note `DOMAIN_HTTP_COOKIE_ONLY` is narrower than knowledge reads, which accept any authenticated principal (`KNOWLEDGE_READ_REQUIRES_PRINCIPAL`); the `GET /api/v1/knowledge` browse response already returns the domain list, so bearer recall does not depend on the domains endpoint. Bearer agents may also read via the contracted port methods.

---

### Port Surface

```typescript
interface KnowledgeStorePort {
  // ... existing methods unchanged

  // NEW
  domainExists(id: string): Promise<boolean>;
  listDomainsFull(): Promise<Domain[]>; // GET endpoint
  registerDomain(input: NewDomain): Promise<Domain>; // POST endpoint
}
```

`listDomains(): Promise<string[]>` (existing) stays for backwards compatibility — it returns DISTINCT domain values from the `knowledge` table, which can drift from `listDomainsFull()`. New callers should prefer `listDomainsFull()`.

`domainExists` and `registerDomain` are convenience wrappers over the shared helper plus an INSERT.

---

### UI Lifecycle (Phase 1, operator-only)

Operator's `/knowledge` page extends the segmented toggle:

```
Before:  [ Browse ] [ Inbox ]
After:   [ Browse ] [ Domains ] [ Inbox ]
```

Domains mode reuses the existing `DataGrid` + Sheet pattern from #1308:

| Element            | Purpose                                                             |
| ------------------ | ------------------------------------------------------------------- |
| `DataGrid` columns | `id` (mono) · `name` · `description` · `entry_count` · `created_at` |
| Header button      | `+ Add domain` opens a Sheet                                        |
| Add Sheet form     | 3 fields: `id`, `name`, `description?`                              |
| On submit          | POST + invalidate React Query key `["knowledge", "domains"]`        |
| On 409             | Inline error in Sheet (`already registered`)                        |

No edit, no delete, no row-detail Sheet in v0. The grid is read + register only.

---

### Seeding

`domains` is **reference data**, not content. The base set is structural to the Cogni knowledge plane and ships with the migrator — every fresh fork has these rows before any agent runs.

`NODES_BOOT_EMPTY` (from [knowledge-data-plane](./knowledge-data-plane.md)) scopes to **content tables** — `knowledge`, `citations`, `sources`. It does **not** apply to the `domains` registry.

**Seeding mechanism:** the migrator script (`nodes/operator/app/src/adapters/server/db/migrate-doltgres.mjs`) holds `BASE_DOMAIN_SEEDS` and runs a `seedBaseDomains()` step after schema migrations are reconciled. It uses `sql.unsafe` with a SELECT-then-INSERT idempotency check, sidestepping two Doltgres 0.56 quirks: (a) drizzle-orm wraps SQL migration files in transactions, and the parameterized-INSERT failure on `drizzle.__drizzle_migrations` rolls them back — DML doesn't survive but DDL does, so data-only `.sql` migrations can't safely apply; (b) `ON CONFLICT EXCLUDED` is broken. SELECT-then-INSERT via simple protocol avoids both. Same pattern as the existing `reconcileTracking` shim in the migrator.

Base domains (operator's set):

| id               | Purpose                                                           |
| ---------------- | ----------------------------------------------------------------- |
| `meta`           | Knowledge about the knowledge system itself                       |
| `nodes`          | Registry / lifecycle facts about other nodes in the Cogni network |
| `infrastructure` | Runtime, deploy, observability                                    |
| `governance`     | DAO formation, attribution, voting                                |

**Per-node domain sets are per-node, not operator-wide.** Each node has its own Doltgres database; each node's migrator owns its own `BASE_DOMAIN_SEEDS`. Operator does NOT seed `prediction-market` (poly's domain) or `reservations` (resy's domain); those are seeded by `nodes/poly/.../migrate-doltgres.mjs` and `nodes/resy/.../migrate-doltgres.mjs` respectively when those nodes ship parallel registry surfaces (out of this PR's scope; see Phase 2 § Registry Node and `Rd-PORTABLE`).

Idempotency: `seedBaseDomains` SELECTs existing `domains.id` values and INSERTs only the missing ones. Re-runs are safe no-ops; net-new rows on first deploy.

The UI's `+ Add domain` flow exists for **extension** — operators registering domains beyond the base set (e.g., `art-marketplace`, `dao-tooling`) as a node's specialization grows. UI registration is the path for net-new domains; it does not duplicate the base set.

---

### Phasing

#### Phase 1 — Operator-Only Registry (THIS spec; task.5038)

```
┌──────────────────────────────────────────────────┐
│  Operator Next.js app  (already hosts /knowledge) │
│                                                   │
│   ┌───────────────────────────────────────────┐   │
│   │  /knowledge   [Browse] [Domains*] [Inbox] │   │
│   │                          │                 │   │
│   │              + Add domain ▼                 │   │
│   │                                             │   │
│   └───────────────────────────────────────────┘   │
│                       │                            │
│                       ▼                            │
│      POST /api/v1/knowledge/domains                │
│                       │                            │
│                       ▼                            │
│            knowledge_operator.domains               │
└──────────────────────────────────────────────────┘

Server-side FK gate (the locking move):
┌──────────────────────────────────────────────────┐
│   Any write to knowledge_operator                  │
│       ├── HTTP /knowledge/contributions             │
│       └── core__knowledge_write tool                │
│                       │                              │
│                       ▼                              │
│        domain ∈ domains?                            │
│            ├─ yes → INSERT proceeds                  │
│            └─ no  → 400 DomainNotRegisteredError    │
└──────────────────────────────────────────────────┘
```

**Scope:**

- Backend (node-agnostic): port methods, adapter helper, contract, error class — all in `packages/`.
- HTTP + UI (operator-bound): three new endpoints + 3-mode toggle in the existing `/knowledge` page.
- Migrator unchanged. Seeds are UI-driven.

**Not in Phase 1:** UI extraction, multi-node hosting, registry-node app shell.

#### Phase 2 — Registry Node (FUTURE, file when a 2nd node needs `/knowledge`)

```
┌──────────────────────────────────────────────────────────────┐
│  Registry node Next.js app  (NEW; vFuture)                     │
│                                                                 │
│   /registry/<node-id>/knowledge                                │
│                  │                                              │
│                  ▼                                              │
│   Mounts @cogni/...-knowledge-ui shared package                │
│   (extracted via Rd-PORTABLE work item)                        │
│                  │                                              │
│       ┌──────────┼──────────┬─────────────┐                    │
│       ▼          ▼          ▼             ▼                    │
│  knowledge_   knowledge_  knowledge_   knowledge_              │
│  operator     poly        resy         <headless>              │
│                                                                 │
│  Empowers headless nodes (knowledge + agents only,             │
│  no own Next.js app) to participate in the system.             │
└──────────────────────────────────────────────────────────────┘
```

**What Phase 2 inherits unchanged from Phase 1:**

- `KnowledgeStorePort` methods (`domainExists`, `listDomainsFull`, `registerDomain`)
- `assertDomainRegistered` helper
- `DomainNotRegisteredError` class
- `knowledge.domains.v1.contract.ts` Zod contract
- Auto-commit semantics

**What Phase 2 adds (NOT in this PR):**

- Per-node URL routing (`/registry/<node-id>/knowledge`)
- Per-node Doltgres client factory (parameterize `DOLTGRES_URL_<NODE>` at request time)
- UI extraction (depends on `Rd-PORTABLE`)
- Cross-node session/auth scope (which nodes can a session manage?)

Phase 1 must therefore avoid hard-coding `knowledge_operator` anywhere in `packages/` — the existing per-node client factory pattern (`buildDoltgresClient(url)`) already satisfies this.

---

## Invariants

| Rule                             | Constraint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DOMAIN_FK_ENFORCED_AT_WRITE`    | Every write to `knowledge` verifies `domain` exists in `domains` before INSERT. Unregistered → `DomainNotRegisteredError` → HTTP 400.                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DOMAIN_REGISTRY_EXTENDS_VIA_UI` | Base domains are seeded by the schema migrator (reference data). The UI's `POST /api/v1/knowledge/domains` is for **extension** — adding new domains beyond the seeded set. `NODES_BOOT_EMPTY` scopes to content tables (`knowledge`, `citations`, `sources`), not `domains`.                                                                                                                                                                                                                                                                                                                        |
| `DOMAIN_CHECK_AT_ADAPTER_LAYER`  | The check lives in the Doltgres adapters (not in `createKnowledgeCapability`), so it shares the caller's client and works on per-PR contribution branches.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `DOMAIN_REGISTRATION_IS_STICKY`  | No DELETE / PUT endpoints in v0. Domain rows are append-only. (Inherits `DEPRECATE_NOT_DELETE` spirit.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DOMAIN_HTTP_COOKIE_ONLY`        | The **direct** GET + POST `/api/v1/knowledge/domains` endpoint is cookie-session only (bearer/x402 rejected) — it is the trusted-human fast-path. This scopes to that endpoint only; bearer agents MAY also **propose** a domain via the contribution flow (`register_domain` edit op on a `contrib/*` branch), merged by a human. No new RBAC: anti-spam = existing contrib-branch + human-merge gate + one-open-contribution-per-principal (W2.5). Narrower than `KNOWLEDGE_READ_REQUIRES_PRINCIPAL`; bearer recall gets the domain list from the `GET /api/v1/knowledge` browse response instead. |
| `DOMAIN_PROPOSABLE_VIA_CONTRIB`  | A `register_domain` contribution edit idempotently INSERTs the domain on the agent's `contrib/*` branch (SELECT-then-INSERT; `ON CONFLICT EXCLUDED` is broken on Doltgres). It surfaces in the contribution diff and takes effect on merge. The adapter applies `register_domain` edits before `insert` edits so a domain registered in the same contribution satisfies the branch FK check (`DOMAIN_FK_ENFORCED_AT_WRITE`).                                                                                                                                                                         |
| `DOMAIN_LIST_SINGLE_QUERY`       | `listDomainsFull()` returns rows + `entry_count` in one SQL query (`LEFT JOIN knowledge … GROUP BY`). No N+1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `DOMAIN_HELPER_SQL_SAFE`         | The shared helper escapes its `domain` argument via `escapeValue()` (Doltgres requires `sql.unsafe`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `DOMAIN_REGISTER_AUTOCOMMITS`    | `registerDomain()` issues `dolt_commit('-Am', 'register domain <id>')` after INSERT. (Inherits `AUTO_COMMIT_ON_WRITE`.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

---

## Non-Goals

- Multi-node UI hosting (Phase 2 / registry node)
- DELETE / PUT domain endpoints
- Per-domain RBAC (`domain_grants` table is vFuture)
- `entry_types` registry (P1 EDO work; architecturally similar but ships serially)
- Bearer / x402 access to `/api/v1/knowledge/domains`
- UI extraction into a shared package (`Rd-PORTABLE`; filed when a 2nd node needs `/knowledge`)

---

## File Pointers

| File                                                                                         | Purpose                                                                           |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/knowledge-store/src/port/knowledge-store.port.ts`                                  | `domainExists`, `listDomainsFull`, `registerDomain` on the port                   |
| `packages/knowledge-store/src/port/knowledge-store.port.ts`                                  | `Domain`, `NewDomain`, `DomainNotRegisteredError`, `DomainAlreadyRegisteredError` |
| `packages/knowledge-store/src/adapters/doltgres/util.ts`                                     | `assertDomainRegistered(client, domain)` helper                                   |
| `packages/knowledge-store/src/adapters/doltgres/index.ts`                                    | Adapter calls helper before write                                                 |
| `packages/knowledge-store/src/adapters/doltgres/contribution-adapter.ts`                     | Adapter calls helper before INSERT loop                                           |
| `packages/node-contracts/src/knowledge.domains.v1.contract.ts`                               | Zod contract for GET/POST                                                         |
| `nodes/operator/app/src/app/api/v1/knowledge/domains/route.ts`                               | Route wrapper                                                                     |
| `nodes/operator/app/src/app/api/v1/knowledge/domains/_handlers.ts`                           | `handleList`, `handleCreate` — error mapping                                      |
| `nodes/operator/app/src/app/(app)/knowledge/view.tsx`                                        | 3-mode toggle (Browse · Domains · Inbox)                                          |
| `nodes/operator/app/src/app/(app)/knowledge/_api/{fetch,create}Domain.ts`                    | Client-side fetchers                                                              |
| `nodes/operator/app/src/app/(app)/knowledge/_components/{domain-columns,AddDomainSheet}.tsx` | UI components                                                                     |

## Related

- [knowledge-syntropy](./knowledge-syntropy.md) — protocol, Critical Path § P0.5
- [knowledge-data-plane](./knowledge-data-plane.md) — `KnowledgeStorePort`, Doltgres infra
- task.5038 — Phase 1 implementation
- `Rd-PORTABLE` (in syntropy) — UI extraction precondition for Phase 2
