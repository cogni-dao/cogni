---
id: spec.preview-deployments
type: spec
title: Preview Deployments — Imperative Preview Controller
status: draft
spec_state: draft
trust: draft
summary: Two-tier preview system. Tier 2 (this spec) = Preview Controller HTTP API + ContainerRuntimePort (DockerAdapter now, AkashAdapter later) + Caddy dynamic routing. Agents POST /deploy, get a URL in 90s, run tests, DELETE. Hard-capped at 3 concurrent. Tier 1 (future) = live AI streaming with pre-warmed sandbox pool.
read_when: Building preview infrastructure, implementing ContainerRuntimePort adapters, wiring CI preview steps, or planning Akash migration.
implements:
owner: derekg1729
created: 2026-04-03
verified:
tags: [infra, preview, container-runtime, akash-forward, dx]
---

> [!WARNING]
> **Stale as of 2026-09-17 — draft, never verified**
> The fleet moved node apps to **Akash** on 2026-09-11; this document was last
> verified never and predates that. Treat its deployment-topology claims as
> historical. The current contract is
> [Node CI/CD Contract](node-ci-cd-contract.md) — see `## Lane vs control env`
> for how `env` splits into lane and control env.

# Preview Deployments — Imperative Preview Controller

## Context

AI coding agents and CI need to validate code changes against a running stack. Today there is no live preview for feature branches — only static tests in CI. The previous design proposed Argo CD ApplicationSet with pullRequest generator. That approach is wrong for three reasons:

1. **Poll latency kills the agent loop.** Argo CD polls git at 3-minute default intervals (requeueAfterSeconds=180). The entire agent e2e loop budget is 5 minutes. Webhooks are an optimization, not a fix for the fundamental impedance mismatch.

2. **Git commits as state changes is wrong for ephemeral resources.** Creating a preview = commit manifest + wait for poll + wait for sync. Destroying = commit deletion + wait again. Ephemeral resources need imperative create/destroy, not declarative reconciliation.

3. **No imperative API for agents.** An agent needs: `POST /deploy` -> URL -> run tests -> `DELETE`. Argo's API requires manifests in git first.

**The boundary:** Argo CD manages staging/production (long-lived, auditable, git-as-truth). The Preview Controller manages previews (ephemeral, imperative, agent-driven).

## Goal

An AI agent or CI pipeline can create a preview deployment via HTTP API and get a live URL within 90 seconds. The preview shares all heavy infrastructure (Postgres, Temporal, LiteLLM, Redis, Caddy) and only runs a thin app workload per-preview. Hard-capped at 3 concurrent previews on a single VM. 48h TTL with automatic cleanup.

## Non-Goals

| Item                                   | Reason                                                            |
| -------------------------------------- | ----------------------------------------------------------------- |
| Argo CD for previews                   | Wrong tool — declarative reconciliation vs imperative lifecycle   |
| Per-preview Temporal/LiteLLM/Redis     | Resource pooling is mandatory; only DB + app are per-preview      |
| More than 3 concurrent previews per VM | Hard cap prevents OOM; Akash removes this limit later             |
| Tier 1 live streaming in this spec     | Separate design — this spec covers Tier 2 (approved preview apps) |
| Akash adapter implementation           | DockerAdapter first; Akash is a future adapter swap               |
| Custom domains for previews            | Wildcard subdomain sufficient                                     |

## Core Invariants

1. **IMPERATIVE_LIFECYCLE**: Previews are created and destroyed via HTTP API calls, not git commits. No reconciliation loop.

2. **SHARED_INFRA_POOLING**: Postgres server, Temporal, LiteLLM, Redis, and Caddy are shared. Per-preview isolation is at the database/namespace/key-prefix level, not the server level.

3. **HARD_CAP_ENFORCED**: Maximum 3 concurrent previews per VM. Controller returns 429 when at capacity. No overcommit.

4. **TTL_CLEANUP**: Every preview has a TTL (default 48h). Expired previews are automatically torn down. No orphaned resources.

5. **ADAPTER_SWAPPABLE**: The `ContainerRuntimePort` interface is the seam. DockerAdapter now, AkashAdapter later. The orchestration logic (DB lifecycle, routing, health polling) is above the adapter.

6. **USAGE_ATTRIBUTED**: Every preview's compute, storage, and DB time is tracked and attributable to a DAO billing account. The ContainerRuntimePort must emit usage records that the billing pipeline can ingest. This is how DAOs pay for preview infrastructure — same billing seam as production node compute.

## Two-Tier Preview Model

### Tier 2: Approved Preview App (this spec)

User/agent approves code -> CI builds image -> Preview Controller deploys -> URL in 90s -> agent runs tests -> teardown.

### Tier 1: Instant AI Preview (future spec)

User talks to AI -> warm sandbox runs code -> live visualization streams to user in real-time -> no CI, no build, no deploy. Pre-warmed runner pool mandatory. Promote to Tier 2 on approval.

## Design

### Architecture

```
+-----------------------------------------------------------------+
|                    Preview Controller                            |
|              (services/workload-controller)                      |
|                                                                  |
|  +--------------+  +-------------------+  +-------------------+  |
|  | HTTP API     |  | Preview           |  | ContainerRuntime  |  |
|  | /api/v1/     |--| Orchestrator      |--| Port              |  |
|  | previews/*   |  |                   |  |                   |  |
|  +--------------+  | - DB provision    |  | +---------------+ |  |
|                    | - Caddy routing   |  | |DockerAdapter  | |  |
|                    | - Health poll     |  | |(now)          | |  |
|                    | - TTL reaper      |  | +---------------+ |  |
|                    | - Quota enforce   |  | |AkashAdapter   | |  |
|                    +-------------------+  | |(later)        | |  |
|                                           | +---------------+ |  |
|                                           +-------------------+  |
+-----------+--------------------+-----------------+---------------+
            |                    |                  |
            v                    v                  v
     +------------+       +----------+        +----------+
     |Shared PG   |       |Caddy     |        |Docker    |
     |CREATE DB   |       |Admin API |        |Engine    |
     |(root DSN)  |       |(:2019)   |        |(socket)  |
     +------------+       +----------+        +----------+
```

## Schema

### Preview Request

```typescript
const previewRequestSchema = z.object({
  branch: z.string(), // feature branch name
  image: z.string(), // GHCR image with digest or tag
  migratorImage: z.string(), // migrator image (same SHA)
  ttl_hours: z.number().default(48), // auto-teardown after TTL
});
```

### Preview Response

```typescript
interface PreviewInfo {
  preview_id: string; // group ID from ContainerRuntimePort
  slug: string; // sanitized branch name (DNS-safe)
  url: string; // https://{slug}.preview.cognidao.org
  database_url: string; // for stack test DB assertions
  status: "provisioning" | "running" | "failed" | "stopped";
  created_at: string;
  expires_at: string;
}
```

## Data Flow

```
1. Agent pushes to feature branch
2. CI builds image, pushes to GHCR (existing pipeline, ~3 min)
3. CI calls Preview Controller:
   POST /api/v1/previews
   { branch, image, migratorImage, ttl_hours: 48 }

4. Preview Controller orchestrates (~60-90s):
   a. Check quota (reject 429 if at cap)
   b. Sanitize branch name to slug (lowercase, / -> _, truncate 40 chars)
   c. createGroup("preview-{slug}")            -> Docker bridge network
   d. Connect network to shared infra networks -> reach PG, Temporal, LiteLLM
   e. CREATE DATABASE preview_{slug}           -> on shared Postgres via root DSN
   f. deploy(groupId, migrator-workload)       -> run Drizzle migrations
   g. Wait for migrator exit code 0            -> abort if non-zero
   h. deploy(groupId, app-workload)            -> start app container
   i. POST Caddy Admin API (:2019)             -> add route for slug
   j. Poll /readyz on app container            -> 30s timeout
   k. Return PreviewInfo with URL

5. CI/Agent runs stack tests:
   APP_BASE_URL=$url pnpm test:stack:dev

6. CI/Agent calls DELETE /api/v1/previews/:id (or TTL expires)

7. Teardown:
   a. DELETE Caddy route via Admin API
   b. destroyGroup -> stop containers, remove network
   c. DROP DATABASE preview_{slug} (with forced disconnect)
```

## Preview Database Provisioning

Reuses the pattern from `infra/compose/runtime/postgres-init/provision.sh`:

```sql
-- Create (idempotent)
CREATE DATABASE preview_{slug} OWNER app_user;
GRANT CONNECT ON DATABASE preview_{slug} TO app_user;
GRANT CONNECT ON DATABASE preview_{slug} TO app_service;

-- Teardown (force disconnect first)
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
  WHERE datname = 'preview_{slug}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS preview_{slug};
```

Controller connects via `DATABASE_ROOT_URL` (admin DSN). Branch names sanitized: lowercase, replace `/` and `.` with `_`, truncate to 40 chars, prefix `preview_`. **After sanitization, slug must match `^[a-z0-9_]+$` — reject otherwise.** Use `quote_ident()` in Postgres for identifier safety. Same allowlist pattern as `infra/compose/runtime/postgres-init/provision.sh:144`.

Migrations run as a transient workload in the same group. Migrator exits -> app starts. Migrator failure aborts the entire preview.

## Preview Routing (Caddy Admin API)

Caddy's admin API (already running on :2019 — confirmed by edge stack healthcheck) supports runtime route injection without restart:

```bash
# Add route
curl -X POST http://localhost:2019/config/apps/http/servers/srv0/routes \
  -H "Content-Type: application/json" \
  -d '{
    "@id": "preview-{slug}",
    "match": [{"host": ["{slug}.preview.cognidao.org"]}],
    "handle": [{"handler": "reverse_proxy", "upstreams": [{"dial": "preview-{slug}-app:3000"}]}]
  }'

# Remove route
curl -X DELETE http://localhost:2019/id/preview-{slug}
```

**DNS (one-time):** Wildcard `*.preview.cognidao.org` -> preview VM IP. Single Cloudflare A record.

**TLS addition to Caddyfile:**

```
*.preview.cognidao.org {
  tls { on_demand }
  respond "Preview not found" 404
}
```

Dynamic routes added via Admin API take precedence. Caddy handles Let's Encrypt automatically per subdomain.

## Resource Budget

The staging/prod VM runs k3s + Argo CD + 3 node apps + Compose infra (6-8GB baseline). Previews should run on a **separate preview VM** to avoid blast radius overlap.

| Per-preview           | RAM                     | Transient? |
| --------------------- | ----------------------- | ---------- |
| App container         | ~512MB                  | No         |
| Scheduler-worker      | ~256MB                  | No         |
| Migrator              | ~256MB                  | Yes (30s)  |
| **Total per preview** | **~768MB steady state** |            |

**Hard cap: 3 concurrent on 8GB VM.** Controller rejects with 429 at capacity. Akash removes this cap later (elastic marketplace compute).

**Same-VM MVP:** Acceptable if budget is tight, but hard cap drops to 2 and OOM risk is real. Plan for separation.

## Portability to Akash

**What IS portable (the runtime seam):**

- `ContainerRuntimePort` interface (`createGroup`, `deploy`, `stop`, `destroyGroup`)
- DockerAdapter swaps for AkashAdapter — same interface, different backend
- Preview Controller orchestration logic (DB lifecycle, migration ordering, health polling, TTL)

**What is NOT portable (VM-specific):**

- Docker networks — Akash uses SDL service groups with internal DNS
- Caddy Admin API (localhost:2019) — Akash exposes via provider-assigned URIs
- Container labels for state reconstruction — Akash tracks via deployment/lease IDs on-chain
- Shared infra on same host — Akash previews connect to managed services (Neon, Temporal Cloud) over public endpoints

**Design implication:** When the Akash adapter lands, the orchestrator adapts — routing, shared infra access, and DB provisioning all change. That's a rewrite of one service, not a plug-and-play swap. Don't over-abstract the orchestrator for a future that will change everything anyway.

## Compute Usage Attribution (TODO)

Every preview consumes compute, storage, and DB time on behalf of a DAO. This cost must be tracked and attributable — it's the same billing seam that production nodes use.

### What Needs Tracking

| Resource             | Metric                             | Attribution Key                       |
| -------------------- | ---------------------------------- | ------------------------------------- |
| App container        | CPU-seconds, memory-MB-hours       | DAO billing account (from node/scope) |
| Scheduler-worker     | CPU-seconds, memory-MB-hours       | Same DAO                              |
| Database             | Storage bytes, connection-hours    | Same DAO                              |
| Migrator (transient) | CPU-seconds (short-lived)          | Same DAO                              |
| Network egress       | Bytes out (if metered by provider) | Same DAO                              |

### How It Connects

- The `PreviewRequest` should include a `scope_id` or `dao_id` that links the preview to a billing account.
- The ContainerRuntimePort (or the orchestrator above it) emits usage records: `{ scope_id, resource_type, quantity, start_time, end_time }`.
- These records feed the existing billing pipeline (`charge_receipts` table, same as LLM usage via LiteLLM callbacks).
- On Akash, the chain handles payment natively (stable payments per block). The usage records become reconciliation data, not the billing source.

### Open Questions

1. **Metering granularity:** Per-second (Docker stats API) or per-preview-lifecycle (start/stop timestamps)? Per-lifecycle is simpler and sufficient for preview environments. Per-second matters for production nodes.
2. **Who pays for preview compute?** The DAO that owns the node being previewed? A shared "platform" account? Free tier for N previews/month?
3. **Integration point:** Does the Preview Controller write `charge_receipts` directly, or emit events that a billing worker consumes? The LiteLLM pattern (callback → ingest endpoint → DB) is proven — reuse it.

This is not blocking for MVP but must be designed before previews are available to external DAOs. Internal previews (operator team) can start without billing.

## Acceptance Checks

1. POST /api/v1/previews returns URL within 90 seconds
2. Preview URL returns 200 on /readyz
3. Stack tests pass: `APP_BASE_URL=$url pnpm test:stack:dev`
4. DELETE tears down fully: containers stopped, network removed, database dropped
5. 4th concurrent preview rejected with 429
6. TTL expiry triggers automatic teardown (48h default)
7. Controller restart reconstructs state from Docker labels (no orphans, no leaked DBs)
8. Migrator failure aborts preview (app never starts)

## Dependencies

- task.0247 (merged infra/ reorg + container-runtime package)
- Wildcard DNS setup (one-time, Cloudflare)
- Preview VM provisioned (or same VM with hard cap for MVP)

## Related

- [CI/CD & Services GitOps Project](../../work/projects/proj.cicd-services-gitops.md) — parent project, P2
- [task.0188](../../work/items/task.0188.per-branch-preview-environments.md) — implementation task
- ContainerRuntimePort — port interface, see `feat/akash-deploy-service` branch `packages/container-runtime/` (to be merged as part of P1)
- Akash Prototype — working testnet deploy script, see `feat/akash-deploy-service` branch `services/akash-deployer/src/runtime/akash-prototype.ts`
- [CD Pipeline E2E](./cd-pipeline-e2e.md) — staging/prod deployment (Argo CD, separate concern)
- [Node Launch](./node-launch.md) — zero-touch provisioning (ClusterProvider, separate interface)
