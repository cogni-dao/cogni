---
id: vcs-integration
type: spec
title: VCS Integration Architecture (ASPIRATIONAL)
status: draft
spec_state: draft
trust: draft
summary: ASPIRATIONAL — NOT as-built. Describes a two-GitHub-App + git-daemon target architecture. As-built today, PR review runs in-process within the Next.js app (no services/git-daemon/, no packages/github-core/). GitHub App authentication, permission tiering, webhook routing, and VCS adapter contracts for integrating git platform operations (ingestion, code review, admin actions) into the Node template.
read_when: Adding a VCS integration, working on GitHub/GitLab auth, wiring webhook handlers, or understanding the git-daemon service.
implements: proj.vcs-integration
owner: derekg1729
created: 2026-02-22
verified: 2026-03-10
tags: [infra, github, auth, services]
---

# VCS Integration Architecture

> ⚠️ **ASPIRATIONAL — NOT the live contract.** This document describes a **target** two-GitHub-App + `services/git-daemon/` architecture that is **not built**. As-built today, PR review runs **in-process** within the Next.js app — there is no `services/git-daemon/` and no `packages/github-core/` (see § Current Implementation below). For the live merge/flight/promote contract, read [development-lifecycle.md §8](./development-lifecycle.md#8-request-merge--the-operator-is-the-merge-authority), [ci-cd.md](./ci-cd.md), and [node-ci-cd-contract.md](./node-ci-cd-contract.md). Do not mistake the Walk-target architecture below for what ships.

> The Node template integrates with GitHub (and future GitLab/Radicle) through **two GitHub Apps** with distinct permission tiers — a read/review app and an admin app — served by a **single backend service** (`services/git-daemon/`). A shared `packages/github-core/` package provides auth primitives. PAT fallback remains for self-hosted Nodes that don't need App-based auth.

### Key References

|                 |                                                                                 |                                        |
| --------------- | ------------------------------------------------------------------------------- | -------------------------------------- |
| **Project**     | [proj.vcs-integration](../../work/projects/proj.vcs-integration.md)             | Roadmap and planning                   |
| **Spec**        | [Node vs Operator Contract](./node-operator-contract.md)                        | Node/Operator boundary, data plane     |
| **Spec**        | [Attribution Ledger](./attribution-ledger.md)                                   | Activity ingestion via source adapters |
| **Spec**        | [Services Architecture](./services-architecture.md)                             | Service contracts and boundaries       |
| **Spec**        | [Packages Architecture](./packages-architecture.md)                             | Package contracts and boundaries       |
| **Sister Repo** | [cogni-git-review](https://github.com/cogni-dao/cogni-git-review)               | PR review bot (to be absorbed)         |
| **Sister Repo** | [cogni-git-admin](https://github.com/cogni-dao/cogni-git-admin)                 | DAO admin bot (to be absorbed)         |
| **Sister Repo** | [cogni-proposal-launcher](https://github.com/Cogni-DAO/cogni-proposal-launcher) | Aragon proposal UI (to be absorbed)    |

## Design

### Current Implementation (Crawl — task.0153)

PR review runs **in-process** within the Next.js app — no `services/git-daemon/` or `packages/github-core/` yet. The architecture below describes the Walk target; this section documents what is built today.

```
GitHub webhook (pull_request.opened / .synchronize / .reopened)
  │
  POST /api/internal/webhooks/github
    ├─ Verify signature (existing)
    ├─ Return 200 immediately
    ├─ [existing] Attribution normalization (sync)
    └─ [Crawl] Fire-and-forget: dispatch PR review (async)
          │
          ├─ src/app/_facades/review/dispatch.server.ts
          │    └─ createInstallationOctokit() → src/adapters/server/review/github-auth.ts
          │
          ├─ src/features/review/services/review-handler.ts
          │    ├─ Create Check Run (in_progress) via injected adapter
          │    ├─ Gather evidence via injected adapter
          │    ├─ Load gates from .cogni/repo-spec.yaml (local fs)
          │    ├─ Gate orchestrator (src/features/review/gate-orchestrator.ts)
          │    │    ├─ review-limits: deterministic size check
          │    │    └─ ai-rule: invoke pr-review graph via GraphExecutorPort
          │    │         └─ packages/langgraph-graphs/src/graphs/pr-review/
          │    ├─ Update Check Run (conclusion + markdown summary)
          │    └─ Post PR comment (staleness guard)
          │
          └─ Billing: system tenant (COGNI_SYSTEM_BILLING_ACCOUNT_ID)
```

**Key differences from Walk target:**

- Auth lives in `src/adapters/server/review/github-auth.ts`, not `packages/github-core/`
- Review dispatched from Next.js webhook route, not `services/git-daemon/`
- Self-install only — reads `.cogni/` from local filesystem
- Graph execution via `GraphExecutorPort` (in-proc), not internal API endpoint

### Why Two GitHub Apps

A single GitHub App with all permissions is rejected for three reasons:

1. **Principle of least privilege.** Read/review permissions (contents:read, checks:write, pull_requests:write) and admin permissions (contents:write, administration:write, members:write) are fundamentally different trust decisions. GitHub grants all requested permissions at install time — there is no "install with partial permissions."

2. **Progressive adoption.** A Node installs the review app first. Later, when the DAO wants on-chain governance of repo admin actions, they install the admin app. This mirrors the node-operator-contract's FORK_FREEDOM invariant — adding admin capabilities is an explicit opt-in, not a bundled default.

3. **Blast radius.** A compromised review app key can post comments and set check statuses. A compromised combined app key can also merge arbitrary PRs and grant admin access. Separate keys = separate blast radii.

### System Overview

```
┌────────────────────────────────────────────────────────────┐
│                    GitHub Platform                          │
│                                                            │
│  ┌─────────────────────┐    ┌───────────────────────────┐  │
│  │ Cogni Review App    │    │ Cogni Admin App           │  │
│  │                     │    │                           │  │
│  │ contents:read       │    │ contents:write            │  │
│  │ pull_requests:write │    │ administration:write      │  │
│  │ checks:write        │    │ members:write             │  │
│  │ issues:read         │    │                           │  │
│  └────────┬────────────┘    └─────────────┬─────────────┘  │
│           │ webhooks                      │ webhooks        │
└───────────┼───────────────────────────────┼────────────────┘
            │                               │
            ▼                               ▼
┌────────────────────────────────────────────────────────────┐
│  services/git-daemon/                                      │
│                                                            │
│  POST /api/v1/webhooks/github    ◄── both apps             │
│  POST /api/v1/webhooks/onchain   ◄── Alchemy (admin only)  │
│  GET  /livez, /readyz                                      │
│                                                            │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ Review       │  │ Admin        │  │ Ingestion        │ │
│  │ Handlers     │  │ Handlers     │  │ Token Provider   │ │
│  │ (graphExec)  │  │ (merge, ACL) │  │ (for scheduler)  │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│           │                │                   │           │
│           └────────────────┴───────────────────┘           │
│                            │                               │
│                   packages/github-core/                    │
│                   (JWT, tokens, verify)                    │
└────────────────────────────────────────────────────────────┘
            │
            │ installation token (read-only)
            ▼
┌────────────────────────────────────────────────────────────┐
│  services/scheduler-worker/                                │
│                                                            │
│  GitHubSourceAdapter.collect()  ◄── uses review app token  │
│  (epoch activity ingestion)         OR PAT fallback        │
└────────────────────────────────────────────────────────────┘
```

### Auth Flow: GitHub App → Installation Token

```
1. git-daemon starts → loads APP_ID + PRIVATE_KEY for each app
2. Signs JWT (RS256, 10min expiry) per GitHub App spec
3. On webhook receipt:
   a. Verify webhook signature (HMAC-SHA256 with app's WEBHOOK_SECRET)
   b. Extract installation_id from webhook payload
   c. POST /app/installations/{id}/access_tokens → short-lived token
   d. Create Octokit client scoped to that installation
   e. Route to appropriate handler based on event type + app identity
```

For ingestion (no webhook trigger — cron-based):

```
1. scheduler-worker needs a read-only token for GitHub GraphQL
2. V0: scheduler-worker owns an InstallationTokenProvider in-process
   → Reads REVIEW_APP_ID, REVIEW_APP_PRIVATE_KEY, REVIEW_INSTALLATION_ID
   → Signs JWT → POST /app/installations/{id}/access_tokens → caches until expiry
   → Passes token into GitHubSourceAdapter
3. V1: Resolve installation ID per-repo via GET /repos/{owner}/{repo}/installation
   → Remove REVIEW_INSTALLATION_ID env var
4. Fallback: GITHUB_TOKEN env var (PAT) for self-hosted Nodes without App auth
```

### Webhook Routing

Each GitHub App gets its own webhook URL so signature verification implicitly identifies the app. (`X-GitHub-Hook-Installation-Target-ID` is NOT the App ID — it's the target resource ID and must not be used for routing.)

```
POST /api/v1/webhooks/github/review   ← Review App webhook URL
  │
  ├─ Verify X-Hub-Signature-256 with REVIEW_APP_WEBHOOK_SECRET
  ├─ pull_request.opened/synchronize/reopened → reviewHandler
  ├─ check_suite.rerequested                  → rerunHandler
  └─ installation_repositories.added           → welcomeHandler

POST /api/v1/webhooks/github/admin    ← Admin App webhook URL
  │
  ├─ Verify X-Hub-Signature-256 with ADMIN_APP_WEBHOOK_SECRET
  └─ (V0: no direct GitHub webhook triggers — admin via onchain path)

POST /api/v1/webhooks/onchain
  │
  ├─ Verify Alchemy HMAC signature
  ├─ Parse CogniAction events from transaction logs
  ├─ Validate DAO address + chain ID
  └─ Execute: merge PR, grant/revoke collaborator
      └─ Uses admin app installation token
```

### Package: `packages/github-core/`

Pure library. No process lifecycle. Shared by `services/git-daemon/` and `services/scheduler-worker/`.

```
packages/github-core/
├── src/
│   ├── jwt.ts              # signAppJwt(appId, privateKey) → JWT string
│   ├── installation.ts     # getInstallationToken(jwt, installationId) → token
│   ├── webhook-verify.ts   # verifyWebhookSignature(secret, payload, signature)
│   ├── client-factory.ts   # createOctokit(token) → Octokit instance
│   ├── types.ts            # GitHubAppConfig, InstallationToken, WebhookEvent
│   └── index.ts            # Public exports
└── tests/
```

Responsibilities:

- JWT signing (RS256) for GitHub App authentication
- Installation access token acquisition
- Webhook signature verification (HMAC-SHA256, timing-safe)
- Octokit client factory with rate-limit awareness

Does NOT contain:

- Webhook routing logic (that's git-daemon's concern)
- Business logic (review, admin, ingestion)
- Probot (replaced by direct GitHub App API usage)

### Service: `services/git-daemon/`

HTTP service per [services-architecture](./services-architecture.md) contracts.

```
services/git-daemon/
├── src/
│   ├── main.ts                # Entry point, signal handling
│   ├── config.ts              # Zod env: REVIEW_APP_ID, ADMIN_APP_ID, keys, secrets
│   ├── health.ts              # /livez, /readyz
│   ├── server.ts              # Fastify (product HTTP traffic)
│   ├── apps/
│   │   ├── review.ts          # Review app config + Octokit factory
│   │   └── admin.ts           # Admin app config + Octokit factory
│   ├── webhooks/
│   │   ├── github.ts          # Webhook router (signature verify → app dispatch)
│   │   └── onchain.ts         # Alchemy webhook handler (HMAC verify → action exec)
│   ├── handlers/
│   │   ├── review/
│   │   │   ├── pr-review.ts   # PR review via graphExecutor
│   │   │   └── rerun.ts       # Check suite re-request
│   │   └── admin/
│   │       ├── merge.ts       # DAO-authorized PR merge
│   │       ├── collaborator.ts # Grant/revoke collaborator
│   │       └── policy.ts      # Authorization policy (DAO allowlist)
│   └── token-provider.ts      # Internal API: issue installation tokens for scheduler
├── Dockerfile
├── package.json               # @cogni/git-daemon-service
└── AGENTS.md
```

### Dropping Probot

Both sister repos use [Probot](https://probot.github.io/). Probot provides:

- GitHub App JWT ↔ installation token management
- Webhook signature verification
- Express middleware for webhook delivery
- Convenience wrappers around Octokit

We replace Probot with direct GitHub API usage (`packages/github-core/`) because:

- Probot v7 is CJS-only; cogni-git-admin already has a CJS shim hack (`runtime.cjs`)
- Probot bundles Express; we use Fastify
- Probot's magic hides auth flow details needed for the token-provider pattern
- The auth primitives are ~200 lines total — no framework needed

### Ingestion Auth: Token Source Abstraction

The `GitHubSourceAdapter` currently accepts `token: string`. This remains correct — the adapter doesn't care whether the token is a PAT or an installation token. The caller provides it:

```typescript
// Self-hosted Node (PAT):
const adapter = new GitHubSourceAdapter({
  token: process.env.GITHUB_TOKEN,
  repos: ["owner/repo"],
});

// Operator-hosted (App installation token):
const token = await tokenProvider.getInstallationToken({
  app: "review",
  installationId: 12345,
});
const adapter = new GitHubSourceAdapter({
  token,
  repos: ["owner/repo"],
});
```

The `tokenProvider` is an internal API exposed by `git-daemon` (or called in-process if scheduler-worker and git-daemon share a runtime).

### Scope Routing at Ingestion

When activity events are ingested, each event must be assigned a `scope_id` (governance/payout domain). See [Identity Model](./identity-model.md) and [Attribution Ledger §Project Scoping](./attribution-ledger.md#project-scoping).

**Routing rules:**

1. **Single-scope V0:** All events get `scope_id = 'default'`. No manifest needed.
2. **Multi-scope:** Each `.cogni/projects/*.yaml` manifest declares which source repositories or file paths belong to the scope. The adapter assigns `scope_id` at ingestion time based on these rules.

**Routing determinism (when multi-scope is active):**

- **Non-overlapping scopes are the default.** If a repository belongs to exactly one scope, all events from that repository get that `scope_id`.
- **Overlapping scopes** (a single repo serves multiple projects): route by file path using **longest-match-wins**. Each project manifest declares `include` path globs. The most specific matching glob wins.
- **Excluded by default:** lockfiles (`**/pnpm-lock.yaml`, `**/package-lock.json`), generated code (`**/generated/**`), and vendor directories (`**/vendor/**`, `**/node_modules/**`) are excluded from path-based routing. These files do not contribute to any scope's attribution.
- **Renames/moves:** A file rename in a PR is treated as two events — a remove from the old path's scope and an add to the new path's scope. If both resolve to the same scope, it collapses to one event.
- **Unresolvable events:** If an event touches only excluded files, or no scope matches, the event is **rejected** (not silently dropped, not assigned to default). This forces explicit manifest configuration.

**Ingestion scoping in the adapter call:**

```typescript
// CollectEpochWorkflow passes scope_id to the adapter context
const events = await adapter.collect({
  streams: ["pull_requests", "reviews"],
  cursor,
  window: { since, until },
  scopeId: "chat-service", // ← scope for this collection run
});
// Events are inserted with scope_id = 'chat-service' on activity_events
```

### External Event Envelope

For external repositories (not in this monorepo) that feed the same attribution pipeline, the system accepts **signed activity event envelopes** via a standardized contract. This enables a GitHub/GitLab repo to push events to a Node's ledger without sharing the monorepo.

**Envelope schema:**

```typescript
interface ActivityEventEnvelope {
  // Routing
  source_repo: string; // "github:cogni-dao/external-lib"
  scope_id: string; // Must match a declared scope in the receiving node
  node_id: string; // Target node (must match receiving node's node_id)

  // Event (same as ActivityEvent from ingestion-core)
  event: {
    id: string; // Deterministic ID (e.g., "github:pr:owner/repo:42")
    source: string;
    eventType: string;
    platformUserId: string;
    platformLogin?: string;
    artifactUrl: string;
    metadata: Record<string, unknown>;
    payloadHash: string; // SHA-256 of canonical payload
    eventTime: string; // ISO 8601
  };

  // Provenance
  producer: string; // Adapter name (e.g., "github-adapter")
  producer_version: string; // Adapter version
  retrieved_at: string; // ISO 8601

  // Integrity
  idempotency_key: string; // = event.id (deterministic, dedup at receiver)
  signature?: string; // Optional: Ed25519 or HMAC signature over canonical envelope
  signer_id?: string; // Optional: identifies the signing key
}
```

**Invariants for external envelopes:**

| Rule                    | Constraint                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- |
| ENVELOPE_SCOPE_REQUIRED | Every envelope must include a `scope_id` that matches a declared scope in the receiving node.               |
| ENVELOPE_IDEMPOTENT     | `idempotency_key` (= `event.id`) prevents duplicate ingestion. Same semantics as ACTIVITY_IDEMPOTENT.       |
| ENVELOPE_NODE_MATCH     | `node_id` in the envelope must match the receiving node's `node_id`. Rejects cross-node misdirects.         |
| ENVELOPE_SIGNATURE_V1   | V0: signature is optional (trust the transport). V1: signature required, verified against a registered key. |

**Receiving endpoint (future):**

```
POST /api/v1/attribution/events/ingest
Content-Type: application/json
Authorization: Bearer <node-api-key>

Body: ActivityEventEnvelope
```

This endpoint validates the envelope, checks `scope_id` against manifests (SCOPE_VALIDATED), and inserts into `activity_events` with the same idempotency guarantees as adapter-collected events.

### Node Registration Lifecycle

When an external project installs the Cogni GitHub App (or connects via any future VCS platform), the Operator discovers a **node** and begins tracking its configuration. The registration entity is the **node** (identified by `node_id` from their `repo-spec.yaml`), not individual scopes. Scopes are a derived, mutable property discovered by syncing the node's configuration over time.

#### Core Port: `NodeRegistrationPort`

Registration is **VCS-agnostic at the core**. GitHub App installation is one adapter; future triggers include GitLab OAuth, manual API registration, or on-chain DAO formation events. The core port defines the lifecycle operations; adapters translate platform-specific events into these operations.

**Capability roles** abstract over platform-specific app installations. A node may have multiple capability tiers installed simultaneously (e.g., Review App + Admin App). Each maps to a `capabilityRole` in the core model — the same abstraction works for GitHub Apps, GitLab OAuth scopes, or PAT permission levels.

```typescript
/**
 * Core port — lives in packages/, no VCS platform dependencies.
 * Adapters (GitHub, GitLab, manual) implement the discovery side.
 * The scheduler-worker (or future operator service) implements the persistence side.
 */

/**
 * Capability roles — what the operator can do for a node.
 * Each role maps to a distinct auth credential (separate GitHub App, OAuth scope, etc.).
 * Roles are additive: a node starts with "review" and may later add "admin" or "contributor".
 */
type CapabilityRole = "review" | "admin" | "contributor";

/** A node announced itself to the operator (or updated its capabilities). */
interface NodeDiscoveryEvent {
  /** How the node was discovered */
  trigger:
    | "vcs_app_installed"
    | "vcs_app_removed"
    | "manual_registration"
    | "onchain_dao_formed";
  /** VCS platform that triggered discovery (null for non-VCS triggers) */
  platform?: "github" | "gitlab";
  /** Platform-specific installation/connection ID */
  platformInstallationId?: string;
  /** Which capability tier this event affects (null for non-VCS triggers) */
  capabilityRole?: CapabilityRole;
  /** Repository where .cogni/repo-spec.yaml lives */
  repoRef: string; // "owner/repo"
}

/** Parsed and validated node configuration from a remote repo-spec. */
interface NodeRegistration {
  nodeId: string; // UUID from their repo-spec
  repoRef: string;
  repoSpecHash: string; // SHA-256 of raw YAML
  scopes: NodeScopeConfig[];
}

/** A capability credential the operator holds for a node. */
interface NodeCapability {
  nodeId: string;
  capabilityRole: CapabilityRole;
  platform: string; // "github" | "gitlab"
  platformInstallationId: string; // GitHub installation_id, etc.
  status: "active" | "suspended" | "removed";
}

interface NodeScopeConfig {
  scopeId: string; // UUID (deterministic: uuidv5(nodeId, scopeKey))
  scopeKey: string;
  activitySources: Record<
    string,
    {
      sourceRefs: string[];
      streams: string[];
      creditEstimateAlgo: string;
    }
  >;
  approvers: string[]; // EVM addresses
  poolConfig: { baseIssuanceCredits: string };
}

/** Persistence port — operator stores node + scope + capability state. */
interface NodeRegistryPort {
  upsertNode(registration: NodeRegistration): Promise<void>;
  getNode(nodeId: string): Promise<NodeRegistration | null>;
  getNodeByRepoRef(repoRef: string): Promise<NodeRegistration | null>;
  listActiveNodes(): Promise<NodeRegistration[]>;
  suspendNode(nodeId: string): Promise<void>;
  removeNode(nodeId: string): Promise<void>;

  /** Capability management — tracks which auth credentials the operator holds per node. */
  upsertCapability(capability: NodeCapability): Promise<void>;
  getCapability(
    nodeId: string,
    role: CapabilityRole
  ): Promise<NodeCapability | null>;
  listCapabilities(nodeId: string): Promise<NodeCapability[]>;
  removeCapability(nodeId: string, role: CapabilityRole): Promise<void>;
}
```

#### Operator-Side Persistence

The operator maintains a **node registry** (distinct from the node's own DB tables in task.0099). Three tables separate identity, capabilities, and scope config. All live in the operator's database and are rebuildable from repo-spec snapshots + VCS platform state.

```
operator_node_registrations                       -- WHO: node identity
  node_id                UUID PRIMARY KEY          -- from their repo-spec
  repo_ref               TEXT NOT NULL             -- "owner/repo"
  repo_spec_hash         TEXT NOT NULL             -- SHA-256 of last synced raw YAML
  status                 TEXT NOT NULL              -- 'active' | 'suspended' | 'removed'
  installed_at           TIMESTAMPTZ NOT NULL
  last_synced_at         TIMESTAMPTZ NOT NULL

operator_node_capabilities                        -- WHAT: auth credentials per app/role
  node_id                UUID NOT NULL             -- FK → registrations
  capability_role        TEXT NOT NULL              -- 'review' | 'admin' | 'contributor'
  platform               TEXT NOT NULL              -- 'github' | 'gitlab'
  platform_install_id    TEXT NOT NULL              -- GitHub installation_id, GitLab hook ID
  status                 TEXT NOT NULL              -- 'active' | 'suspended' | 'removed'
  installed_at           TIMESTAMPTZ NOT NULL
  PRIMARY KEY (node_id, capability_role)

operator_node_scopes                              -- SCOPE: governance config per project
  node_id                UUID NOT NULL             -- FK → registrations
  scope_id               UUID NOT NULL             -- from their repo-spec / projects/*.yaml
  scope_key              TEXT NOT NULL
  config_snapshot        JSONB NOT NULL            -- scope-level config (sources, approvers, pool)
  temporal_schedule_id   TEXT                      -- Temporal schedule handle for this scope's epochs
  status                 TEXT NOT NULL              -- 'active' | 'paused' | 'removed'
  last_synced_at         TIMESTAMPTZ NOT NULL
  PRIMARY KEY (node_id, scope_id)
```

**Three-table design rationale:** A node has one identity (registrations), N capability tiers (capabilities), and N governance scopes (scopes). Capabilities and scopes change independently — installing the Admin App doesn't change scopes, and adding a `.cogni/projects/chat.yaml` manifest doesn't change which apps are installed. Merging these into one table would force composite keys that conflate orthogonal concerns.

**Relationship to node-operator-contract §Operator Node Registry:** The `node_registry_nodes` table referenced there is this `operator_node_registrations` table. Per DATA_SOVEREIGNTY, the operator never accesses the node's own DB — these are derived snapshots from repo-spec fetches.

#### Registration Flow

A discovery event does two things: (1) register/update the **node** identity + scopes, and (2) register/update the **capability** that the installing app provides. These are independent — a second app install for the same repo updates capabilities without re-registering the node (unless the repo-spec also changed).

```
1. Discovery event arrives (VCS webhook, manual API call, on-chain event)
   ├─ GitHub adapter: installation_repositories.added webhook
   │   └─ Webhook URL determines capability_role:
   │       /webhooks/github/review → role="review"
   │       /webhooks/github/admin  → role="admin"
   ├─ GitLab adapter: project hook registration callback (future)
   └─ Manual adapter: POST /api/v1/operator/nodes/register { repoRef }

2. Upsert capability (for VCS-triggered events)
   └─ Upsert operator_node_capabilities (keyed by node_id + capability_role)
      with platform_install_id from the webhook payload

3. Fetch remote repo-spec (if node not yet registered, or periodic sync)
   ├─ Select token: use any active capability with contents:read
   │   (review app preferred — least privilege for a read operation)
   ├─ GitHub: octokit.repos.getContent({ path: ".cogni/repo-spec.yaml" })
   ├─ GitLab: gitlab.RepositoryFiles.show() (future)
   └─ Manual: caller provides YAML content directly

4. Parse and validate
   ├─ parseRepoSpec(yamlString) via @cogni/repo-spec (task.0120)
   ├─ Extract node_id, scope(s), activity sources, approvers
   └─ Reject if: missing node_id, invalid schema, scope_id derivation mismatch

5. Persist registration + reconcile scopes
   ├─ Upsert operator_node_registrations (keyed by node_id)
   ├─ Diff scopes: compare fetched vs. cached operator_node_scopes
   │   ├─ New scope → insert row, create Temporal schedule
   │   ├─ Changed scope → update config_snapshot, update schedule input
   │   └─ Removed scope → mark 'removed', pause Temporal schedule
   └─ Update repo_spec_hash and last_synced_at

6. Create/update epoch schedules (per scope)
   └─ Each active scope gets a CollectEpochWorkflow Temporal schedule
       with AttributionIngestRunV1 input derived from scope config
```

**Multi-app installation sequence example:**

```
Day 1: Node installs Review App
  → installation_repositories.added on /webhooks/github/review
  → Upsert capability: (node_id, "review", install_id=12345)
  → Node is new → fetch repo-spec → register node → create epoch schedules
  → Ingestion begins (uses review app token for GraphQL reads)

Day 30: Node installs Admin App
  → installation_repositories.added on /webhooks/github/admin
  → Upsert capability: (node_id, "admin", install_id=67890)
  → Node already registered, repo-spec unchanged → SYNC_IDEMPOTENT (no-op)
  → Admin handlers now available for this node (merge, grant, revoke)
  → Epoch ingestion continues using review app token (unchanged)

Day 60: Node uninstalls Admin App only
  → installation.deleted on /webhooks/github/admin
  → Remove capability: (node_id, "admin") → status='removed'
  → Node registration stays active (review still installed)
  → Admin handlers disabled; ingestion unaffected
```

#### Capability-Scoped Token Selection

When the operator needs to perform an action on a node's repo, it must select the correct capability's auth token. **A workflow must never use a token with more permissions than the action requires.** This is enforced by the `VcsTokenProvider` port's `capability` parameter (already defined in `packages/ingestion-core/src/vcs-token-provider.ts`).

```typescript
// Existing port — capability param selects the right app
interface VcsTokenProvider {
  getToken(params: {
    provider: string; // "github"
    capability: string; // "review" | "admin" | "contributor"
    repoRef?: string; // "owner/repo"
  }): Promise<VcsTokenResult>;
}
```

**Token selection rules:**

| Operation                                 | Required capability                                 | Token source                       | If capability missing                                                 |
| ----------------------------------------- | --------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Fetch repo-spec (`.cogni/repo-spec.yaml`) | `review` (contents:read)                            | Review App installation token      | Fall back to any active capability with contents:read; reject if none |
| Collect activity (PRs, reviews, issues)   | `review` (contents:read, issues:read)               | Review App installation token      | Fail: cannot ingest without read access                               |
| Post PR review comments                   | `review` (pull_requests:write)                      | Review App installation token      | Fail: review handler unavailable                                      |
| Create/update check runs                  | `review` (checks:write)                             | Review App installation token      | Fail: check handler unavailable                                       |
| Merge PR (DAO-authorized)                 | `admin` (contents:write)                            | Admin App installation token       | Fail: admin handler unavailable for this node                         |
| Grant/revoke collaborator                 | `admin` (administration:write)                      | Admin App installation token       | Fail: admin handler unavailable for this node                         |
| Create PR / push branch                   | `contributor` (contents:write, pull_requests:write) | Contributor App installation token | Fail: contributor handler unavailable                                 |

**Security invariant:** The `VcsTokenProvider` implementation resolves the `capability` parameter to the correct `platform_install_id` from `operator_node_capabilities`. It must **never** fall back to a higher-privilege token when a lower-privilege one is requested but unavailable. If a node has only the Admin App installed and a workflow requests `capability: "review"`, the provider must **reject** — not silently use the admin token for a read operation. This prevents privilege creep where a workflow designed for read-only access accidentally gains write permissions.

```typescript
// In the multi-app token provider (operator-side implementation):
async getToken({ provider, capability, repoRef }) {
  const cap = await registry.getCapability(nodeId, capability);
  if (!cap || cap.status !== "active") {
    throw new CapabilityNotInstalledError(nodeId, capability);
    // NEVER fall back to a different capability role
  }
  // Sign JWT for the specific app, exchange for installation token
  return this.exchangeInstallationToken(cap.platformInstallationId);
}
```

#### Sync Triggers

Three events cause the operator to re-fetch a node's configuration:

| Trigger             | Source                                                              | Mechanism                                     |
| ------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| **Initial install** | VCS platform webhook (`installation_repositories.added` for GitHub) | Webhook handler → full registration flow      |
| **Config push**     | VCS platform webhook (`push` event where `.cogni/**` files changed) | Webhook handler → re-fetch → reconcile scopes |
| **Periodic cron**   | Operator scheduler (e.g., daily)                                    | Iterate active nodes → re-fetch → reconcile   |

The `push`-triggered sync requires the webhook handler to inspect the push payload's `commits[].modified` / `commits[].added` arrays for `.cogni/` path prefixes. Only `.cogni/**` changes trigger a re-sync — not every push.

#### Uninstall / Removal

Uninstalling a **single app** removes one capability. Uninstalling **all apps** (or the last remaining app) triggers full node suspension. The webhook URL tells us which app was removed.

```
1. VCS platform fires uninstall event for one app
   ├─ GitHub: installation.deleted on /webhooks/github/review or /admin
   └─ GitLab: project hook removal callback (future)

2. Remove capability
   └─ Set operator_node_capabilities.status = 'removed' for that role

3. Check remaining capabilities
   ├─ If NO active capabilities remain:
   │   ├─ Suspend all epoch schedules for this node
   │   │   ├─ Set operator_node_scopes.status = 'paused' for all scopes
   │   │   └─ Pause all Temporal schedules
   │   └─ Set operator_node_registrations.status = 'suspended'
   │
   ├─ If the REVIEW capability was removed (but others remain):
   │   ├─ Pause epoch ingestion schedules (ingestion requires review token)
   │   └─ Admin/contributor handlers may still function if their apps remain
   │
   └─ If a NON-REVIEW capability was removed (review still active):
       └─ Node registration and ingestion unaffected
          Only handlers requiring the removed capability become unavailable

4. Data retention: capability, registration, and scope rows are soft-deleted
   (not purged). Historical epochs, receipts, and statements remain in the
   operator DB per RECEIPT_APPEND_ONLY and ledger immutability invariants.
```

#### Invariants

| Rule                      | Constraint                                                                                                                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REGISTRATION_NODE_KEYED   | The operator registers **nodes** (by `node_id`), not repos or scopes. A node may change repos (fork) or scopes (add/remove projects) over time.                                                                                                                                  |
| REGISTRATION_VCS_AGNOSTIC | Core registration port (`NodeRegistryPort`) has no VCS platform types. GitHub/GitLab are adapters that produce `NodeDiscoveryEvent`s.                                                                                                                                            |
| CAPABILITY_SCOPED_AUTH    | Each workflow requests a specific `capabilityRole` when acquiring a token. The token provider resolves to the exact app installation for that role. It must **never** fall back to a higher-privilege token when the requested capability is unavailable — fail, don't escalate. |
| CAPABILITY_INDEPENDENT    | Installing/uninstalling one app does not affect other apps on the same node. The Review App and Admin App have independent lifecycles, credentials, and blast radii.                                                                                                             |
| REPO_SPEC_AUTHORITY       | Operator reads the node's repo-spec; never invents or overrides policy. If the fetched spec is invalid, the operator rejects (does not substitute defaults).                                                                                                                     |
| SCOPE_RECONCILIATION      | On every sync, the operator diffs cached scopes against fetched scopes. New scopes create schedules; removed scopes pause schedules; changed configs update schedule inputs.                                                                                                     |
| SYNC_IDEMPOTENT           | Re-fetching an unchanged repo-spec (same hash) is a no-op. No schedule restarts, no DB writes.                                                                                                                                                                                   |
| SOFT_DELETE_ONLY          | Node removal soft-deletes registration rows. Historical ledger data is never purged.                                                                                                                                                                                             |

### GitLab Support (Future)

The architecture is VCS-agnostic at the handler level:

| Concern              | GitHub                         | GitLab (future)                   |
| -------------------- | ------------------------------ | --------------------------------- |
| Auth                 | GitHub App (JWT + install tok) | OAuth 2.0 + OIDC (token refresh)  |
| Webhook verification | HMAC-SHA256 (X-Hub-Signature)  | Shared secret (X-Gitlab-Token)    |
| API client           | Octokit                        | @gitbeaker/rest                   |
| Webhook endpoint     | `/api/v1/webhooks/github`      | `/api/v1/webhooks/gitlab`         |
| Token storage        | Stateless (short-lived)        | Encrypted DB (2h expiry, refresh) |

The cogni-git-review sister repo already has a `VcsProvider` interface abstracting over GitHub/GitLab. This pattern carries forward into the handlers.

### Permission Matrix

| Capability             | Review App | Admin App | PAT Fallback |
| ---------------------- | ---------- | --------- | ------------ |
| Read repo contents     | Y          | Y         | Y            |
| Read PRs/issues        | Y          | Y         | Y            |
| Post PR comments       | Y          | N         | Y            |
| Create/update checks   | Y          | N         | N            |
| Merge PRs              | N          | Y         | Y (if admin) |
| Grant collaborator     | N          | Y         | Y (if admin) |
| Revoke collaborator    | N          | Y         | Y (if admin) |
| GraphQL search queries | Y          | N         | Y            |

### Relationship to Node-Operator Contract

Per [node-operator-contract](./node-operator-contract.md):

- `git-daemon` is **Operator data plane** (`services/*`)
- Call direction: Operator → Node repo (via VCS API)
- Node installs the GitHub Apps on its repos (Node's trust decision)
- Operator runs the backend (or Node self-hosts it — DEPLOY_INDEPENDENCE)
- Operator never gains wallet/DB custody (WALLET_CUSTODY, DATA_SOVEREIGNTY)

The two-app model maps cleanly to the Boot Seams Matrix:

| Seam            | App Used   | Self-Host Option |
| --------------- | ---------- | ---------------- |
| PR code review  | Review App | OSS standalone   |
| Repo admin      | Admin App  | OSS standalone   |
| Activity ingest | Review App | PAT fallback     |

## Goal

Provide a unified, secure VCS integration layer where: (1) authentication is handled by a shared pure package, (2) all webhook and API traffic routes through a single service with clean handler separation, (3) read/review and admin permissions are isolated into separate GitHub Apps, and (4) the ingestion pipeline can use either App tokens or PAT fallback without code changes.

## Non-Goals

- GitLab implementation (future — architecture supports it, not built yet)
- Radicle/other VCS providers
- GitHub App marketplace listing or OAuth user-facing flows
- Multi-tenant Operator hosting (covered by node-operator-contract)
- Review graph logic or prompt engineering (covered by graph-execution spec)
- On-chain event decoding details (covered by cogni-git-admin's Aragon integration)

## Invariants

| Rule                         | Constraint                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TWO_APPS_SEPARATE_KEYS       | Review and admin GitHub Apps have independent APP_ID + PRIVATE_KEY pairs. A single compromised key cannot escalate to the other's scope.                               |
| WEBHOOK_SIGNATURE_REQUIRED   | Every inbound webhook (GitHub, Alchemy) must pass HMAC-SHA256 signature verification before any handler executes.                                                      |
| APP_ROUTE_BY_URL             | Each GitHub App has a distinct webhook URL (`/github/review`, `/github/admin`). Routing is by URL path + signature verification, not by inspecting payload or headers. |
| TOKEN_SHORT_LIVED            | Installation access tokens expire per GitHub's 1-hour TTL. Never persisted to disk or database.                                                                        |
| PAT_FALLBACK_SUPPORTED       | `GitHubSourceAdapter` accepts any valid token string. Callers may provide a PAT or an installation token — adapter is auth-agnostic.                                   |
| ADMIN_ACTIONS_DAO_AUTHORIZED | Admin app handlers (merge, grant, revoke) execute only after verifying on-chain CogniAction event from an authorized DAO.                                              |
| NO_PROBOT_DEPENDENCY         | Neither `packages/github-core/` nor `services/git-daemon/` depend on Probot. Auth primitives are implemented directly.                                                 |
| SERVICE_ISOLATION            | `services/git-daemon/` imports only from `packages/*`. Never from `src/` or other services. (Inherited from services-architecture.)                                    |
| REVIEW_HANDLER_VIA_GRAPH     | PR review logic executes through the graphExecutor (LangGraph), not inline in the webhook handler.                                                                     |
| REGISTRATION_NODE_KEYED      | Operator registers nodes (by `node_id`), not repos or scopes. Scopes are derived from syncing the node's config.                                                       |
| REGISTRATION_VCS_AGNOSTIC    | Core registration port has no VCS platform types. GitHub/GitLab are adapters that produce discovery events.                                                            |
| CAPABILITY_SCOPED_AUTH       | Token provider resolves `capabilityRole` to the exact app installation. Never falls back to a higher-privilege token — fail, don't escalate.                           |
| CAPABILITY_INDEPENDENT       | Installing/uninstalling one app does not affect other apps on the same node. Independent lifecycles, credentials, blast radii.                                         |
| SCOPE_RECONCILIATION         | On every sync, operator diffs cached scopes against fetched scopes. New → create schedule; removed → pause; changed → update.                                          |
| SYNC_IDEMPOTENT              | Re-fetching an unchanged repo-spec (same hash) is a no-op.                                                                                                             |

### Environment Configuration

**`services/git-daemon/src/config.ts`** (Zod-validated, fail-fast):

| Variable                    | Required | Description                              |
| --------------------------- | -------- | ---------------------------------------- |
| `REVIEW_APP_ID`             | Yes      | GitHub App ID for the review app         |
| `REVIEW_APP_PRIVATE_KEY`    | Yes      | Base64-encoded PEM private key (review)  |
| `REVIEW_APP_WEBHOOK_SECRET` | Yes      | Webhook HMAC secret (review)             |
| `ADMIN_APP_ID`              | No       | GitHub App ID for the admin app (opt-in) |
| `ADMIN_APP_PRIVATE_KEY`     | No       | Base64-encoded PEM private key (admin)   |
| `ADMIN_APP_WEBHOOK_SECRET`  | No       | Webhook HMAC secret (admin)              |
| `ALCHEMY_SIGNING_KEY`       | No       | Required if admin app is configured      |
| `PORT`                      | No       | HTTP listen port (default: 3100)         |

Admin app variables are optional — a Node may install only the review app.

### File Pointers

| File                                      | Purpose                                         |
| ----------------------------------------- | ----------------------------------------------- |
| `packages/github-core/src/`               | JWT, installation tokens, webhook verification  |
| `services/git-daemon/src/`                | Webhook server, handler dispatch                |
| `services/git-daemon/src/config.ts`       | Zod env schema (both app configs)               |
| `services/git-daemon/src/apps/`           | Per-app Octokit factory                         |
| `services/git-daemon/src/handlers/`       | Business logic (review, admin)                  |
| `services/scheduler-worker/src/adapters/` | GitHubSourceAdapter (token-agnostic)            |
| `packages/ingestion-core/src/port.ts`     | SourceAdapter interface                         |
| `packages/repo-spec/src/`                 | Repo-spec Zod schemas + pure parser (task.0120) |
| `packages/db-schema/src/operator.ts`      | Operator node registry tables (future)          |

## Open Questions

- [ ] Should `git-daemon` expose a gRPC or HTTP internal API for token provisioning to `scheduler-worker`, or should they share an in-process factory via a package import?
- [ ] What is the migration path for existing cogni-git-review Probot installations? Do we maintain backward-compatible webhook URLs during transition?
- [ ] Should the admin app's authorization policy (DAO allowlist) live in the Node's DB or in a config file? DB is more dynamic; config file is simpler and auditable.
- [ ] Rate limit strategy: should `github-core` implement token rotation across multiple installation tokens, or is single-installation rate limit (5000 req/hr) sufficient for V0?
- [ ] Should the operator's node registry tables live in the same Postgres as the scheduler-worker (monorepo phase) or a separate database? Same DB is simpler; separate DB is cleaner for eventual extraction.
- [ ] For push-triggered re-sync: should the webhook handler parse the push payload inline to detect `.cogni/**` changes, or re-fetch unconditionally and rely on SYNC_IDEMPOTENT (hash comparison) to short-circuit?
- [ ] Should `.cogni/projects/*.yaml` manifests in external repos be fetched via individual `repos.getContent` calls, or via a tree listing + batch fetch? Tree listing is one API call but returns all files.
- [ ] **Rename `.cogni/projects/` → `.cogni/scopes/`** — "scopes" is the canonical term in the identity model and attribution ledger. "Projects" is overloaded (GitHub projects, project management). All ~30 references across specs, tasks, and roadmap need updating when multi-scope ships. V0 doesn't need the directory at all — the default scope lives at the top level of `repo-spec.yaml`.

## Related

- [Node vs Operator Contract](./node-operator-contract.md) — data plane boundaries, self-host requirements
- [Attribution Ledger](./attribution-ledger.md) — consumes GitHub activity via source adapters
- [Services Architecture](./services-architecture.md) — service contracts git-daemon must satisfy
- [Packages Architecture](./packages-architecture.md) — package contracts github-core must satisfy
- [Graph Execution](./graph-execution.md) — review handler executes via graphExecutor
- [Identity Model](./identity-model.md) — node_id, scope_id, user_id definitions and relationships
- [Node Formation](./node-formation.md) — DAO formation generates repo-spec with node_id
