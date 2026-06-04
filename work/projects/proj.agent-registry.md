---
id: proj.agent-registry
type: project
primary_charter:
title: Agent Registry & Multi-Adapter Discovery
state: Paused
priority: 2
estimate: 4
summary: Evolve agent discovery from single in-proc catalog to multi-adapter registry with LangGraph Server, Claude SDK, and n8n/Flowise providers; plus a Node Registry Track unifying monorepo + wizard node discovery behind one NodeRegistryPort read model (projection over the repo-spec/node-spec SSOT)
outcome: Unified agent discovery across all execution backends with stable defaultAgentId and LangGraph Server field alignment
assignees: derekg1729
created: 2026-02-06
updated: 2026-06-04
labels: [ai-graphs]
---

# Agent Registry & Multi-Adapter Discovery

## Goal

Evolve the agent discovery pipeline from the current single in-proc LangGraph catalog provider to a multi-adapter registry supporting LangGraph Server runtime discovery, Claude SDK, and n8n/Flowise providers. Decouple `agentId` from `graphId` to support multi-assistant-per-graph scenarios.

## Roadmap

### Crawl (P0) — MVP Discovery (Complete)

**Goal:** Basic discovery pipeline with in-proc LangGraph catalog.

| Deliverable                                                                   | Status | Est | Work Item |
| ----------------------------------------------------------------------------- | ------ | --- | --------- |
| `AgentCatalogPort` interface in `src/ports/agent-catalog.port.ts`             | Done   | 1   | —         |
| `AgentDescriptor` with `agentId`, `graphId`, `name`, `description` (nullable) | Done   | 1   | —         |
| `LangGraphInProcAgentCatalogProvider` (discovery-only, no execution deps)     | Done   | 1   | —         |
| `AggregatingAgentCatalog` implementing `AgentCatalogPort`                     | Done   | 1   | —         |
| `/api/v1/ai/agents` route using `listAgentsForApi()` from bootstrap           | Done   | 1   | —         |
| `listGraphs()` removed from `GraphExecutorPort` (execution-only)              | Done   | 1   | —         |

### Walk (P1) — Discovery/Execution Split & LangGraph Server

**Goal:** Clean separation of discovery and execution registries; LangGraph Server runtime discovery.

| Deliverable                                                                                                                                                 | Status      | Est | Work Item            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Create `createAgentCatalogProvidersForDiscovery()` factory in bootstrap                                                                                     | Not Started | 1   | (create at P1 start) |
| Add bootstrap-time assertion: discovery providers never in execution registry                                                                               | Not Started | 1   | (create at P1 start) |
| Add unit test: execution registry contains no discovery-only providers                                                                                      | Not Started | 1   | (create at P1 start) |
| Make `defaultAgentId` app-configurable via env override                                                                                                     | Not Started | 1   | (create at P1 start) |
| Validate `defaultAgentId` exists in returned agents                                                                                                         | Not Started | 1   | (create at P1 start) |
| Create `LangGraphServerCatalogProvider` calling `/assistants/search`                                                                                        | Not Started | 2   | (create at P1 start) |
| Add LangGraph Server provider to discovery registry                                                                                                         | Not Started | 1   | (create at P1 start) |
| Handle server-discoverable graphs (runtime, not static catalog)                                                                                             | Not Started | 2   | (create at P1 start) |
| Replace hardcoded `AVAILABLE_GRAPHS` in `ChatComposerExtras` with API fetch from `/api/v1/ai/agents`                                                        | Not Started | 1   | (create at P1 start) |
| Deduplicate agent name/description: `SandboxAgentCatalogProvider` and `SANDBOX_AGENTS` define independently — catalog should derive from execution registry | Not Started | 1   | (create at P1 start) |

**LangGraph Server Field Alignment (P1+):**

| LangGraph Server Field                | Our Field        | P0 Status              | P1+ Target                        |
| ------------------------------------- | ---------------- | ---------------------- | --------------------------------- |
| `assistant_id` (UUID)                 | —                | Not exposed            | Expose when multi-assistant lands |
| `graph_id` (string)                   | `graphId` suffix | `langgraph:{graph_id}` | Same                              |
| `name`                                | `name`           | Aligned                | Same                              |
| `description`                         | `description`    | Aligned (nullable)     | Same                              |
| `config`                              | —                | Not exposed            | Expose if UI needs config         |
| `metadata`                            | —                | Not exposed            | Extensible metadata               |
| `version`, `created_at`, `updated_at` | —                | Not exposed            | Versioning support                |

### Run (P2+) — Multi-Adapter Discovery

**Goal:** Unified discovery across all execution backends.

| Deliverable                                                      | Status      | Est | Work Item            |
| ---------------------------------------------------------------- | ----------- | --- | -------------------- |
| Claude SDK catalog adapter (if/when available)                   | Not Started | 2   | (create at P2 start) |
| n8n/Flowise discovery (if demand materializes)                   | Not Started | 2   | (create at P2 start) |
| Add `providerRef` to `AgentDescriptor` for adapter-specific data | Not Started | 1   | (create at P2 start) |
| Decouple `agentId` from `graphId` for multi-assistant-per-graph  | Not Started | 2   | (create at P2 start) |

### Identity & Registration Track

> Source: `docs/AGENT_REGISTRY_SPEC.md` — Spec: [agent-registry.md](../../docs/spec/agent-registry.md)

#### P0: Canonical Schema + Offchain Registry

**Goal:** `AgentRegistrationDocument` schema, `AgentIdentityPort`, DB-backed offchain registry with content hashing.

| Deliverable                                                                                                                                                 | Status      | Est | Work Item |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Extend `AgentDescriptor` in `src/ports/agent-catalog.port.ts` with optional registry fields (`version`, `endpoints`, `registrationHash`)                    | Not Started | 1   | —         |
| Create `AgentRegistrationDocument` type: full descriptor + `services[]` + `active` flag (aligns with ERC-8004 registration file shape)                      | Not Started | 1   | —         |
| Create `AgentIdentityPort` in `src/ports/agent-identity.port.ts`: `register(doc)`, `resolve(agentId)`, `publish(agentId, target)`                           | Not Started | 1   | —         |
| Implement `OffchainAgentRegistryAdapter` in `src/adapters/server/agent-registry/offchain.adapter.ts`: DB-backed, stores signed descriptors                  | Not Started | 2   | —         |
| Create `agent_registrations` table in `@cogni/db-schema`: `id`, `agent_id`, `registration_hash`, `descriptor_json`, `signed_by`, `created_at`, `updated_at` | Not Started | 1   | —         |
| Implement content-hash function: `computeRegistrationHash(doc: AgentRegistrationDocument) → string`                                                         | Not Started | 1   | —         |
| Wire adapter into bootstrap composition root                                                                                                                | Not Started | 1   | —         |
| Publish hook stub: `AgentIdentityPort.publish()` returns `{ published: false, reason: 'no_target_configured' }` when no on-chain adapter                    | Not Started | 1   | —         |
| Observability instrumentation                                                                                                                               | Not Started | 1   | —         |
| Documentation updates                                                                                                                                       | Not Started | 1   | —         |

#### P1: ERC-8004 Identity Adapter

**Goal:** On-chain publication via ERC-8004 identity registry, feature-flagged.

| Deliverable                                                                                                                                           | Status      | Est | Work Item |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Create `Erc8004IdentityRegistryAdapter` in `src/adapters/server/agent-registry/erc8004.adapter.ts`                                                    | Not Started | 2   | —         |
| Map `AgentRegistrationDocument` → ERC-8004 registration file JSON (`type`, `name`, `description`, `image`, `services[]`, `active`, `registrations[]`) | Not Started | 1   | —         |
| Implement `register()`: mint NFT via `IAgentIdentityRegistry.register(agentURI, metadata[])`                                                          | Not Started | 2   | —         |
| Implement `publish()`: update `agentURI` via `setAgentURI(agentId, newURI)`                                                                           | Not Started | 1   | —         |
| Feature flag: `AGENT_REGISTRY_ERC8004_ENABLED` (default: false)                                                                                       | Not Started | 1   | —         |
| Host registration file JSON at stable URI (IPFS or signed HTTP)                                                                                       | Not Started | 2   | —         |

#### P2: Trust Signals + Indexer (Future)

**Goal:** Reputation layer and cross-chain discovery. Do NOT build preemptively — evaluate after P1 adoption and ERC-8004 mainnet stability.

| Deliverable                                                                                    | Status      | Est | Work Item |
| ---------------------------------------------------------------------------------------------- | ----------- | --- | --------- |
| Create `AgentTrustSignalsPort`: `submitFeedback()`, `queryReputation()`, `requestValidation()` | Not Started | 2   | —         |
| Create `Erc8004ReputationAdapter` wrapping `IReputationRegistry`                               | Not Started | 2   | —         |
| Create `IndexerAdapter` for cross-chain agent discovery (subgraph/ETL)                         | Not Started | 3   | —         |

## Node Registry Track

> Added 2026-06-04. Sibling to the agent registry: agents are graphs, **nodes are apps/repos**, but both need one discovery read model + port. Goal: unify node discovery (monorepo + wizard-created) behind a single queryable `NodeRegistryPort` so the operator homepage — and its future sorting/browsing controls — read one source instead of a hand-curated module. Respects `REPO_SPEC_IS_IDENTITY_SSOT` and the **repo-spec → node/scope-spec roadmap**: git-authored specs stay the SSOT; the DB `nodes` table is a **projection (read model)**, never a second source of truth.

### Problem — three disjoint registries today

| Surface        | Source of truth                                                                               | Dynamic?         |
| -------------- | --------------------------------------------------------------------------------------------- | ---------------- |
| monorepo nodes | `infra/catalog/*.yaml` + `.cogni/repo-spec.yaml` (git; build-time only, NOT in runtime image) | no               |
| wizard nodes   | operator Postgres `nodes` table (RLS, owner-private)                                          | yes, but private |
| homepage       | hand-typed module + committed PNGs (PR #1479)                                                 | no               |

Creating a node via the wizard writes a `nodes` row + opens a repo-spec PR, but it never surfaces on the public homepage. The homepage reads neither registry. (Runtime constraint: `COGNI_REPO_PATH=/app` ships only operator's `.cogni`, so `infra/catalog` cannot be globbed at runtime — see `reference_operator_runtime_image_no_catalog`.)

### Design — CQRS-lite: authoring SSOT (git) → read model (DB) → public port

- **Authoring SSOT stays in git.** repo-spec (evolving → node-spec/scope-spec) authors monorepo nodes; the wizard authors new nodes. `node_id`/`scope_id`/`scope_key` are sourced from the spec, never minted in the projection.
- **Generalize the existing `nodes` table into the unified read model** (refine-in-place, no parallel system): add a `source` discriminator (`monorepo` | `wizard`) + a curation layer (`listed`, `featured`, `display_order`, `tagline`, `homepage_url`, `thumbnail_url`, `category`/`tags`). Wizard-only on-chain columns stay nullable.
- **Two writers feed the projection:** (a) a build/migrate-time **reconciler** upserts monorepo nodes from a codegen'd catalog/repo-spec snapshot (`source=monorepo`); (b) the **wizard** upserts on publish and flips `listed` at `published`/`active`.
- **One public read port:** `NodeRegistryPort.listPublic({ sort, filter, page })` — non-RLS, distinct from the owner-scoped wizard reads. Homepage + future sort/browse become plain SQL on one table.
- **Thumbnails** = a `thumbnail_url` column, fed by a screenshot service or per-node `opengraph-image` route. Orthogonal — swap the source without touching the read model.

Matches the product vision: operator = git-manager indexing N node repos → the `nodes` table _is_ that index/projection.

### Crawl (P0) — visual prototype (Done, PR #1479)

| Deliverable                                                        | Status | Est | Work Item |
| ------------------------------------------------------------------ | ------ | --- | --------- |
| Static typed-module showcase + committed homepage screenshots      | Done   | 1   | PR #1479  |
| Server-side href resolution via `host_for_node` catalog convention | Done   | 1   | PR #1479  |

### Walk (P1) — NodeRegistryPort + projection (the alignment)

| Deliverable                                                                                                                                       | Status      | Est | Work Item            |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Generalize `nodes` table: `source` + curation columns (`listed`, `featured`, `display_order`, `tagline`, `homepage_url`, `thumbnail_url`, `tags`) | Not Started | 2   | (create at P1 start) |
| Build/migrate-time reconciler: catalog/repo-spec snapshot → idempotent upsert of `source=monorepo` rows                                           | Not Started | 2   | (create at P1 start) |
| `NodeRegistryPort` (shared package): `listPublic({ sort, filter, page })` + `getBySlug`                                                           | Not Started | 2   | (create at P1 start) |
| Public, non-RLS read adapter over `nodes` (`listed=true`)                                                                                         | Not Started | 1   | (create at P1 start) |
| Point homepage `NodeShowcase` at the port; drop the typed module                                                                                  | Not Started | 1   | (create at P1 start) |
| Map node-spec/scope-spec fields → `NodeSummary` (carry `scope_id`/`scope_key`)                                                                    | Not Started | 1   | (create at P1 start) |

### Run (P2+) — browse/sort + dynamic thumbnails

| Deliverable                                                                                         | Status      | Est | Work Item            |
| --------------------------------------------------------------------------------------------------- | ----------- | --- | -------------------- |
| Homepage sorting / filtering / pagination UI over the port                                          | Not Started | 2   | (create at P2 start) |
| Dynamic thumbnails: per-node `opengraph-image` route OR build-time screenshot job → `thumbnail_url` | Not Started | 2   | (create at P2 start) |
| Cross-repo nodes (operator indexing N external node repos)                                          | Not Started | 3   | (create at P2 start) |

### Node Registry Constraints

- `PROJECTION_NOT_SSOT`: the `nodes` table is a read model; git specs are authoritative. The reconciler is idempotent and never mints identity.
- `REPO_SPEC_IS_IDENTITY_SSOT`: `node_id`/`scope_id`/`scope_key` come from repo-spec (→ node/scope-spec), never the DB.
- `PUBLIC_READ_IS_SEPARATE`: the public `listPublic` path must not reuse the owner-RLS wizard reads.
- Boundary (Phase 3a): `NodeRegistryPort` is a shared-package port (operator + future runtimes), pure domain, deps via constructor.

## Constraints

- Discovery providers must NOT require execution infrastructure (no `CompletionStreamFn`, no tool runners)
- `agentId` format `${providerId}:${graphName}` must remain stable across backend changes
- `DEDUPE_BY_AGENTID`: if multiple providers return the same `agentId`, log error and prefer first in registry order
- `SORT_FOR_STABILITY`: output sorted by `name` for stable UI rendering

## Dependencies

- [ ] LangGraph Server deployment for runtime discovery (P1)
- [ ] Claude SDK availability for catalog adapter (P2)
- [ ] n8n/Flowise integration decision (P2)

## As-Built Specs

- [agent-discovery.md](../../docs/spec/agent-discovery.md) — discovery pipeline invariants, provider types, AgentDescriptor shape
- [agent-registry.md](../../docs/spec/agent-registry.md) — registration schema, identity port, content hashing, ERC-8004 mapping (draft)
- [node-formation.md](../../docs/spec/node-formation.md) — wizard formation flow + repo-spec output (Node Registry Track)
- [.cogni/repo-spec.yaml](../../.cogni/repo-spec.yaml) — node/scope identity SSOT (→ node-spec/scope-spec roadmap)
- [infra/catalog/\*.yaml](../../infra/catalog) — monorepo node catalog (CATALOG_IS_SSOT)

## Design Notes

Discovery track content extracted from original `docs/spec/agent-discovery.md` (Phase 1-3 checklists + LangGraph Server Alignment Roadmap) during docs migration. Identity & Registration track content extracted from `docs/AGENT_REGISTRY_SPEC.md` (P0-P2 implementation checklists).

**P0 simplifications (current):**

- `agentId === graphId` (one agent per graph, no assistant variants)
- No `capabilities` field (was bespoke, not LangGraph Server aligned)
- No `providerRef` (deferred to P3 multi-adapter)
