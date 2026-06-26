---
id: chain-config-spec
type: spec
title: Chain Configuration
status: active
spec_state: draft
trust: draft
summary: DAO governance-controlled chain and wallet config via repo-spec.yaml with startup-time alignment validation.
read_when: Working with chain configuration, payment addresses, or repo-spec validation.
owner: derekg1729
created: 2026-02-06
verified: 2026-02-06
tags: [web3]
---

# Chain Configuration

## Context

**Authority:** `.cogni/repo-spec.yaml` is the DAO's governance-controlled source of truth for which chain and wallet to use.

**Enforcement:** `src/shared/web3/chain.ts` defines deployment-time constants, and `repoSpec.server.ts` refuses to start if repo-spec doesn't match them.

## Goal

Ensure chain identity and payment addresses are governed in git (not env), validated at startup, and enforced at both schema and runtime levels.

## Non-Goals

- Runtime chain switching (different builds for different chains)
- Env-based override of DAO addresses
- Signed/attested repo-specs (deferred, tracked in proj.chain-deployment-refactor.md)

## Core Invariants

1. **REPO_SPEC_SOURCE_OF_TRUTH**: DAO governance declares `chain_id` and `receiving_address` in `.cogni/repo-spec.yaml`.

2. **STRONGLY_TYPED_CHAIN_CONSTANTS**: `src/shared/web3/chain.ts` MUST export constants matching repo-spec or startup fails.

3. **SCHEMA_ENFORCED_STRUCTURE**: `repoSpec.schema.ts` validates repo-spec shape; `repoSpec.server.ts` validates chain alignment with `chain.ts`.

4. **SINGLE_ACTIVE_CHAIN_PER_DEPLOYMENT**: No runtime chain switching; different builds for different chains.

5. **SINGLE_PATH_DIFFERENT_CONTENTS**: All deployments (dev/preview/prod) read `.cogni/repo-spec.yaml` from the same path; the app never branches on env to pick a different file.

6. **RPC_IN_ENVIRONMENT**: `EVM_RPC_URL` varies per deployment, never committed. It is a **provisioned per-env substrate** (`node declares shape; operator wires environment`, [node-baas-architecture.md](./node-baas-architecture.md)) classified `inheritFrom: operator` (the same proven pattern as `OPENROUTER_API_KEY` / `LITELLM_MASTER_KEY`). Within the managed fleet it is **inherited, not human-supplied per node**: the **operator holds one value per env** (a billed, account-specific endpoint), and every spawned node-app pod inherits it via `secret-materialize.sh` — overwrite-on-drift self-heals a divergent copy, so a node can't keep a stale/missing RPC. `source: human` denotes byte-origin (a vendor RPC URL); the lone human action is the operator (or a **standalone sovereign fork**, which has no operator ancestor) seeding it **once** at `cogni/<env>/operator/EVM_RPC_URL` — nodes then converge to it on their next materialize (bug.5087: kills the blind-scan stale/missing copy, the same class the LLM-key `inheritFrom` fixed). Follow-up: an operator-side RPC **usage/balance** port/adapter (mirrors the compute-balance port) so Alchemy rate-limit / plan headroom is observable — billed substrate should be queryable, not silent.

## Design

### Usage

```typescript
// ✅ CORRECT: Get DAO wallet from repo-spec, chain constants from code
import { CHAIN_ID, USDC_TOKEN_ADDRESS } from "@/shared/web3/chain";
import { getPaymentConfig } from "@/shared/config";

const { receivingAddress } = getPaymentConfig(); // DAO wallet (repo-spec)
const chainId = CHAIN_ID; // Chain constant (code)
const token = USDC_TOKEN_ADDRESS; // Token address (code)

// ❌ WRONG: Don't use getPaymentConfig() for chain constants
const { chainId } = getPaymentConfig(); // Use CHAIN_ID from chain.ts
```

### Validation Flow

```
.cogni/repo-spec.yaml (DAO governance)
         ↓
  Zod schema validation (structure)
         ↓
  chainId === CHAIN_ID check (alignment)
         ↓
  getPaymentConfig() returns { receivingAddress, provider }
```

Misalignment throws: `"Chain mismatch: repo-spec declares X, app requires Y"`

### Environment-Specific Repo-Specs

- **Preview vs prod wallets:** Preview and prod may use _different_ repo-spec YAMLs (e.g. different receiving addresses), but both MUST pass the same `repoSpec.schema.ts` validation and chain alignment checks.
- **Config injection by infra:** CI/CD or orchestration mounts the appropriate repo-spec for each environment at `.cogni/repo-spec.yaml` (e.g. `repo-spec.preview.yaml` → mounted as `.cogni/repo-spec.yaml` in preview), keeping application code environment-agnostic.
- **No env matrix in repo-spec:** Environment selection (`DEPLOY_ENVIRONMENT`, `APP_ENV`) is handled by env vars and adapter wiring; repo-spec describes "this node's DAO identity," not a multi-env config matrix.

### File Pointers

| File                                   | Role                                        | Owns                                                                 |
| -------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------- |
| `.cogni/repo-spec.yaml`                | DAO governance (source of truth)            | `governance.chain_id`, `payments_in.credits_topup.receiving_address` |
| `src/shared/web3/chain.ts`             | Deployment constants (must match repo-spec) | `CHAIN`, `CHAIN_ID`, `USDC_TOKEN_ADDRESS`, `MIN_CONFIRMATIONS`       |
| `src/shared/config/repoSpec.schema.ts` | Structure validation                        | Zod schemas for repo-spec YAML                                       |
| `src/shared/config/repoSpec.server.ts` | Loader + alignment check                    | `getPaymentConfig()` validates `chain_id` === `CHAIN_ID`             |
| `.env`                                 | Runtime RPC endpoint                        | `EVM_RPC_URL`                                                        |

## Acceptance Checks

**Automated:**

- App startup fails if `chain_id` in repo-spec doesn't match `CHAIN_ID` in `chain.ts`

**Manual:**

1. Verify `getPaymentConfig()` returns correct `receivingAddress` from repo-spec
2. Verify misaligned chain_id triggers startup failure with descriptive error

## Open Questions

_(none — long-term hardening tracked in proj.chain-deployment-refactor.md: signed repo-spec, hash verification, attested builds, revocation policy)_

## Related

- [DAO Enforcement](./dao-enforcement.md)
