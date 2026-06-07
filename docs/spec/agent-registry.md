---
id: agent-registry
type: spec
title: Agent Registry
status: draft
spec_state: draft
trust: draft
summary: Canonical agent registration schema, offchain-first identity port, content hashing, and optional ERC-8004 on-chain publication
read_when: Building agent registration, identity resolution, or on-chain publication features
implements:
owner: derekg1729
created: 2026-02-04
verified:
tags: [ai-graphs, identity, blockchain]
---

# Agent Registry

## Context

Cogni agents need a registration layer beyond the discovery catalog — one that supports integrity hashing, signed descriptors, and optional on-chain publication via ERC-8004. The existing `AgentCatalogPort` handles discovery; this spec defines the persistence and publication layer above it.

> [!CRITICAL]
> Cogni works fully without chain. On-chain publication (ERC-8004) is an export, never a prerequisite. AgentDescriptor is the canonical schema; adapters map to external specs.

## Goal

Provide a canonical `AgentRegistrationDocument` schema and `AgentIdentityPort` that enables offchain agent registration with content-hash integrity, optional on-chain publication via ERC-8004, and adapter-based extensibility — all without ever gating agent operation on blockchain availability.

## Non-Goals

- Building trust signals or reputation systems (deferred to P2+)
- Cross-chain indexing or federation discovery
- Storing credentials or secrets in registration records

## Core Invariants

1. **OFFCHAIN_FIRST**: All agent identity, discovery, and resolution works without any blockchain dependency. On-chain registries are optional publication targets.

2. **NO_SECRETS_ON_CHAIN**: Descriptors contain endpoints, capabilities, and metadata only. Never credentials, API keys, or connection secrets. Runtime auth uses `connectionId` via broker (see [tenant-connections.md](./tenant-connections.md)).

3. **STABLE_CANONICAL_SCHEMA**: `AgentDescriptor` is the Cogni-owned canonical schema, versioned internally. Adapters map to/from evolving external specs (ERC-8004, A2A, MCP). Core code never imports external schema types directly.

4. **DESCRIPTOR_CONTENT_HASHABLE**: Registration documents are deterministically serializable. `sha256(canonicalize(descriptor))` produces a stable fingerprint for integrity verification, on-chain hash commitments, and cache invalidation.

5. **SINGLE_IDENTITY_PORT**: All registration/resolution/publication flows go through `AgentIdentityPort`. No adapter-specific imports in features or app layers.

6. **AGENT_ID_STABLE**: `agentId` format remains `${providerId}:${graphName}` per existing [agent-discovery.md](./agent-discovery.md) invariant. The registry adds a `registrationId` (content-hash-based) as a separate, portable identifier.

7. **NODE_EFFECTIVE_CATALOG**: Registration input is the node's effective runtime catalog exported by `@cogni/<node>-graphs`, not the shared base package by itself. Operator-only graphs can register on operator without leaking into node-template forks.

## Schema

### `agent_registrations` table

**Allowed columns:**

- `id` (uuid, PK) — Registration record ID
- `agent_id` (text, unique, not null) — Stable agent identifier (`providerId:graphName`)
- `registration_hash` (text, not null) — `sha256(canonicalize(descriptor))` for integrity
- `descriptor_json` (jsonb, not null) — Full `AgentRegistrationDocument` payload
- `signed_by` (text, nullable) — Wallet address or key ID of signer
- `signature` (text, nullable) — Detached signature over `registration_hash`
- `published_chain_id` (integer, nullable) — Chain ID if published on-chain
- `published_token_id` (text, nullable) — ERC-721 token ID if minted
- `created_at` (timestamptz, not null)
- `updated_at` (timestamptz, not null)

**Forbidden columns:**

- `credentials`, `api_key`, `access_token` — per NO_SECRETS_ON_CHAIN
- `private_key`, `mnemonic` — never stored

**Why:** Registration is metadata + endpoints only. Credentials flow through the connection broker at invocation time.

**RLS:** `agent_registrations` is tenant-scoped via `billing_account_id` (added as FK). Follows dual DB client pattern per [database-rls.md](./database-rls.md).

### `AgentRegistrationDocument` Shape

```typescript
/** Cogni canonical schema — adapters map to/from external specs */
interface AgentRegistrationDocument {
  /** Schema version for forward compatibility */
  schemaVersion: "1.0";
  /** Stable agent ID (same as AgentDescriptor.agentId) */
  agentId: string;
  /** Human-readable name */
  name: string;
  /** Description of agent capabilities */
  description: string | null;
  /** Agent service endpoints */
  services: AgentServiceEndpoint[];
  /** Whether the agent is currently active and accepting requests */
  active: boolean;
  /** On-chain registrations (populated after publish) */
  registrations: AgentChainRegistration[];
}

interface AgentServiceEndpoint {
  /** Service name (e.g., "chat", "code-review") */
  name: string;
  /** Endpoint URL */
  endpoint: string;
  /** Protocol: "a2a" | "mcp" | "http" */
  protocol: string;
}

interface AgentChainRegistration {
  /** ERC-8004 token ID */
  agentId: number;
  /** Registry identifier: "eip155:{chainId}:{registryAddress}" */
  agentRegistry: string;
}
```

**Mapping to ERC-8004 registration file:**

| Cogni field       | ERC-8004 field    | Notes                                                               |
| ----------------- | ----------------- | ------------------------------------------------------------------- |
| `schemaVersion`   | `type`            | Maps to `"https://eips.ethereum.org/EIPS/eip-8004#registration-v1"` |
| `name`            | `name`            | Direct                                                              |
| `description`     | `description`     | Direct                                                              |
| —                 | `image`           | Generated or placeholder; not in Cogni canonical                    |
| `services[]`      | `services[]`      | Same shape; Cogni adds `protocol` field                             |
| `active`          | `active`          | Direct                                                              |
| `registrations[]` | `registrations[]` | Same shape                                                          |

## Design

### Key Decisions

### 1. AgentDescriptor vs AgentRegistrationDocument

`AgentDescriptor` (from [agent-discovery.md](./agent-discovery.md)) remains the discovery type — minimal, used by UI. `AgentRegistrationDocument` is the full registration type — used for persistence and publication. Both are derived from the node-effective runtime catalog: operator reads `@cogni/operator-graphs`; default nodes read their own `@cogni/<node>-graphs` package.

| Type                          | Purpose                   | Where used                      |
| ----------------------------- | ------------------------- | ------------------------------- |
| **AgentDescriptor**           | Discovery + UI display    | `AgentCatalogPort.listAgents()` |
| **AgentRegistrationDocument** | Persistence + publication | `AgentIdentityPort.register()`  |

**Rule:** `AgentRegistrationDocument` can always produce an `AgentDescriptor` (projection). Never the reverse.

**Runtime scope rule:** A registration job must run once per node catalog it publishes. Reading `@cogni/langgraph-graphs` directly is insufficient because that package contains shared base catalogs but does not represent a deployed node's final runtime policy.

### 2. Publication Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│ REGISTRATION (offchain, always available)                           │
│ ─────────────────────────────────                                   │
│ 1. Agent code defines descriptor in graph manifest                  │
│ 2. Bootstrap builds AgentRegistrationDocument from node catalog     │
│ 3. OffchainAdapter stores in agent_registrations table              │
│ 4. computeRegistrationHash() for integrity fingerprint              │
│ 5. Result: REGISTERED (offchain)                                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if ERC-8004 adapter enabled)
┌─────────────────────────────────────────────────────────────────────┐
│ PUBLICATION (on-chain, feature-flagged)                              │
│ ───────────────────────────                                         │
│ - Map AgentRegistrationDocument → ERC-8004 JSON                     │
│ - Host registration file at stable URI                              │
│ - Call IAgentIdentityRegistry.register(agentURI) or setAgentURI()   │
│ - Store returned tokenId in agent_registrations.published_token_id  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ DISCOVERY (never blocking on chain)                                 │
│ ─────────────────────────                                           │
│ - AgentCatalogPort.listAgents() reads from offchain registry        │
│ - On-chain data is supplementary (enrichment), not required         │
│ - Existing discovery pipeline unchanged                             │
└─────────────────────────────────────────────────────────────────────┘
```

**Why offchain-first?** ERC-8004 is still draft. Chain availability must never gate agent operation. Registration hash enables integrity verification without chain dependency.

### 3. Content Hashing Strategy

Deterministic serialization via JSON Canonicalization Scheme (RFC 8785):

1. `canonicalize(doc)` → deterministic JSON string (sorted keys, no whitespace)
2. `sha256(canonicalized)` → hex digest
3. Hash used for: DB uniqueness, on-chain `feedbackHash` / `requestHash`, cache keys

**Never** hash non-deterministic representations (pretty-printed JSON, objects with insertion-order keys).

### 4. Adapter Selection

**Feature flags:**

- `AGENT_REGISTRY_OFFCHAIN_ENABLED` — always true (hardcoded)
- `AGENT_REGISTRY_ERC8004_ENABLED` — default false, opt-in per environment

**Composition root** wires adapters based on flags. `AgentIdentityPort.publish()` delegates to enabled adapters. If no on-chain adapter, publish is a no-op that returns `{ published: false }`.

### File Pointers

| File                                                        | Purpose                                                                           |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `nodes/<node>/graphs/src/index.ts`                          | Node-effective catalog source for registration                                    |
| `nodes/<node>/app/src/ports/agent-catalog.port.ts`          | Extend `AgentDescriptor` with optional `version`, `endpoints`, `registrationHash` |
| `nodes/<node>/app/src/ports/agent-identity.port.ts`         | New port: `register`, `resolve`, `publish`                                        |
| `nodes/<node>/app/src/adapters/server/agent-registry/*`     | DB-backed registry with signed descriptors                                        |
| `packages/db-schema/src/agent-registry.ts`                  | `agent_registrations` table                                                       |
| `nodes/<node>/app/src/bootstrap/agent-registry.factory.ts`  | Composition root wiring                                                           |
| `packages/node-contracts/src/agent-registry.v1.contract.ts` | Zod schemas for registry API                                                      |

## Acceptance Checks

**Automated:**

- (none yet — spec_state: draft, code not implemented)

**Manual:**

1. `AgentRegistrationDocument` type compiles and produces valid `AgentDescriptor` projection
2. `computeRegistrationHash()` is deterministic across serialization round-trips
3. `AgentIdentityPort.publish()` returns `{ published: false }` when no on-chain adapter configured
4. Operator-only graphs register from `@cogni/operator-graphs` and are absent from node-template/canary/resy registration outputs

## Open Questions

- [ ] Should `AgentRegistrationDocument` include a `capabilities` field or defer to service-level metadata?

## Related

- [agent-discovery.md](./agent-discovery.md) — `AgentDescriptor` is a projection of `AgentRegistrationDocument`; discovery pipeline unchanged
- [tenant-connections.md](./tenant-connections.md) — descriptors never contain credentials; runtime auth via `connectionId` + broker
- [database-rls.md](./database-rls.md) — dual DB client pattern for tenant-scoped tables
- [node-formation.md](./node-formation.md) — P3 federation enrollment may reference agent registrations for DAO-published agents
- [tool-use.md](./tool-use.md) — tool capabilities advertised in `services[].skills` align with tool catalog
- [proj.agent-registry.md](../../work/projects/proj.agent-registry.md) — implementation roadmap (P0–P2 checklists)
