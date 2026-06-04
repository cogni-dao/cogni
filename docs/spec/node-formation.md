---
id: node-formation-spec
type: spec
title: Node Formation Design
status: draft
spec_state: draft
trust: draft
summary: Node lifecycle from formation (governance identity) through payment activation (operator wallet + Split). Formation via web wizard; activation via child-node CLI.
read_when: Working on DAO formation, the setup wizard, aragon-osx package, or payment activation.
implements:
owner: derekg1729
created: 2026-02-07
verified:
tags: [web3, setup, dao]
---

# Node Formation Design

## Context

A Cogni DAO node has three lifecycle phases with distinct trust domains:

1. **Formation** — governance identity (DAO + Signal). Runs in the shared operator repo's web UI. No secrets, no operator wallet, no payment rails.
2. **Publish** — the operator authors the node's monorepo footprint (`nodes/<slug>/**` + catalog row + per-env overlays + per-node AppSets) as a single GitHub App–authored PR, directly via the GitHub Git Data API. No GitHub Action, no human PAT. See [Node Publish](#node-publish-operator-authored-pr).
3. **Payment Activation** — operator wallet + revenue split. Runs in the child node's own trust domain via CLI. The child node owns its Privy credentials and operator wallet.

Formation outputs a repo-spec fragment with `payments.status: pending_activation`. Publish lands that fragment into the monorepo as a reviewable PR; once merged + flighted, the node deploys per-node (see [ci-cd.md](ci-cd.md) Axiom 18). The child node then activates payments.

> Formation is Node-owned tooling. No Operator dependencies. Wallet signs in browser; server verifies before persisting.
> Payment activation belongs to the child node's trust domain. The shared operator repo never creates or controls child wallets.

## Goal

Enable any founder to create a fully-verified Cogni DAO node via a 3-field web form and 2 wallet transactions, then activate payment rails via a single CLI command in their own fork.

## Non-Goals

| Item                                | Reason                                                          |
| ----------------------------------- | --------------------------------------------------------------- |
| Multiple initial holders            | P1 scope (reduces P0 to 2 wallet txs)                           |
| Custom NonTransferableVotes token   | Aragon GovernanceERC20 sufficient for P0                        |
| Anti-vote-buying (non-transferable) | Not a P0 invariant; revisit if needed                           |
| Terraform provisioning              | CLI scope (P1)                                                  |
| GitHub secrets automation           | CLI scope (P1)                                                  |
| Repo clone/patch/write              | Now the **Publish** phase — operator App authors it (task.5092) |
| CLI wallet signing                  | Web is simpler; add if proven needed                            |
| Contract verification (Etherscan)   | Nice-to-have, not blocking                                      |
| Payment activation in formation     | Wrong trust domain — child node owns its Privy wallet           |
| Split deployment in formation       | Requires operator wallet that doesn't exist at formation time   |

## Core Invariants

1. **MINIMAL_USER_INPUT**: Form collects only:
   - `tokenName` (string) - e.g., "Cogni Governance"
   - `tokenSymbol` (string) - e.g., "COGNI"
   - `initialHolder` (address) - single founder, receives 1e18 tokens

   User wallet signs 2 transactions: `createDao` + `deployCogniSignal`.

2. **ARAGON_MINTED_TOKEN**: Use Aragon's GovernanceERC20 minted during DAO creation. No custom NonTransferableVotes deployment. Tokens are transferable.

   Forward note: the Financial Ledger reward-distribution path reuses this same `GovernanceERC20` as the rewards token. The current founder bootstrap mint is acceptable for formation testing, but it is NOT the final rewards-ready setup. Before live contributor distributions, formation must mint a fixed supply to a DAO-controlled emissions holder and the server verification path must validate that holder and total supply.

3. **NO_PRIVATE_KEY_ENV_VARS**: Formation transactions are signed via wallet UI (wagmi/rainbowkit), never by script-loaded secrets. Payment activation (child node CLI) uses `DEPLOYER_PRIVATE_KEY` for Split deployment — this is acceptable because it runs in the child node's own environment, not the shared operator repo.

4. **SERVER_VERIFICATION_BOUNDARY**: Browser is untrusted. Server derives ALL addresses from tx receipts. Request contains only `{ chainId, daoTxHash, signalTxHash, initialHolder }`.

5. **PACKAGE_ISOLATION**: `aragon-osx` cannot import `src/`, `services/`, or browser/node-specific APIs.

6. **FORK_FREEDOM**: Formation tooling works standalone without Cogni Operator accounts.

7. **FORMATION_IS_GOVERNANCE_ONLY**: Formation outputs `cogni_dao` and `payments.status: pending_activation`. It does NOT provision operator wallets, deploy Split contracts, or configure payment rails. Those belong to payment activation in the child node's trust domain.

8. **CHILD_OWNS_OPERATOR_WALLET**: The child node's Privy app credentials create and control the operator wallet. The shared operator repo never creates, stores, or administers child node wallets.

9. **PAYMENTS_ACTIVE_REQUIRES_ALL**: A node's payments are active only when repo-spec contains all of: `payments.status: active`, `operator_wallet.address`, `payments_in.credits_topup.receiving_address`, `payments_in.credits_topup.provider`, `payments_in.credits_topup.allowed_chains`, `payments_in.credits_topup.allowed_tokens`. Missing any field means payments are inactive — the app skips the funding chain gracefully.

10. **SPLIT_CONTROLLER_IS_OPERATOR**: The Split contract's owner/controller is the operator wallet (Privy-managed). This enables programmatic allocation updates if pricing constants change. The deployer (founder wallet) signs the deployment tx but does not retain admin control.

## Schema

**User Input (P0 form - 3 fields):**

- `tokenName` (string, required) - e.g., "Cogni Governance"
- `tokenSymbol` (string, required) - e.g., "COGNI"
- `initialHolder` (address, required) - Single founder, receives 1e18 tokens

**Derived (not user input):**

- `chainId` - From connected wallet (must be in `SUPPORTED_CHAIN_IDS`)

**Verify Request (to server):**

- `chainId`, `daoTxHash`, `signalTxHash`, `initialHolder`
- No addresses - server derives all from receipts

**Verify Response (from server):**

- `addresses.dao`, `addresses.token`, `addresses.plugin`, `addresses.signal`
- `repoSpecYaml` - Ready to write, `chain_id` as string per existing schema

**Forbidden:**

- `privateKey`, `mnemonic`, `seed`
- Client-provided addresses (server derives from receipts)

## Design

### Technology Stack

| Layer                   | Choice                                              | Rationale                                               |
| ----------------------- | --------------------------------------------------- | ------------------------------------------------------- |
| **ABI Encoding**        | viem `encodeAbiParameters`                          | Direct control over TokenVoting struct encoding         |
| **Wallet Connection**   | wagmi + RainbowKit (existing)                       | Already configured in `src/shared/web3/wagmi.config.ts` |
| **Tx Signing**          | `useWriteContract` + `useWaitForTransactionReceipt` | Proven pattern in `usePaymentFlow.ts`                   |
| **State Machine**       | `useReducer`                                        | Proven pattern for multi-step async flows               |
| **Contract Deployment** | wagmi `useDeployContract`                           | For CogniSignal only (no custom token)                  |
| **Server Verification** | viem `getTransactionReceipt` + `decodeEventLog`     | Server derives addresses from receipt events            |

**Why NOT Aragon SDK?**

- Adds abstraction over single `DAOFactory.createDao()` call
- We need exact control over TokenVoting encoding (MintSettings with initial holder)
- viem encoding matches Foundry script 1:1 (easier to audit parity)

### Contract ABIs Required

**Aragon ABIs:** → `src/shared/web3/node-formation/aragon-abi.ts`

- DAOFactory (createDao, pluginSetupProcessor)
- TokenVoting (getVotingToken)
- GovernanceERC20 (balanceOf)

**CogniSignal:** → `src/shared/web3/node-formation/bytecode.ts`

- ABI + bytecode for deployment (extracted from cogni-gov-contracts)

**Source:** Minimal ABIs from OSx v1.4.0 contracts and Foundry artifacts.

### Hook Architecture

**State Machine:** → `src/features/setup/daoFormation/formation.reducer.ts`

Phases: IDLE → PREFLIGHT → CREATING_DAO → AWAITING_DAO_CONFIRMATION → DEPLOYING_SIGNAL → AWAITING_SIGNAL_CONFIRMATION → VERIFYING → SUCCESS/ERROR

**Hooks:**

- `src/features/setup/hooks/useDAOFormation.ts` - Thin wagmi wiring layer
- `src/features/setup/hooks/useAragonPreflight.ts` - Preflight validation

**Pure Modules:**

- `src/features/setup/daoFormation/txBuilders.ts` - Transaction argument builders
- `src/features/setup/daoFormation/api.ts` - Server verification client

### Server Verification Endpoint

**Contract Schema:** → `src/contracts/setup.verify.v1.contract.ts`

**Implementation:** → `src/app/api/setup/verify/route.ts`

**Receipt Decoders:** → `packages/aragon-osx/src/osx/receipt.ts`

Server derives addresses from receipts (never trusts client):

1. Decode `daoTxHash` → extract DAO + plugin addresses from events (DAORegistered, InstallationApplied)
2. Call `TokenVoting(plugin).getVotingToken()` → token address
3. Decode `signalTxHash` → extract CogniSignal address from contractAddress
4. Verify `balanceOf(initialHolder) == 1e18` and `CogniSignal.DAO() == dao`
5. Return verified addresses + repo-spec YAML

### viem Encoding (TokenVoting Setup with Mint)

**Encoder:** → `packages/aragon-osx/src/encoding.ts` (`encodeTokenVotingSetup`)

**Constants:** → `packages/aragon-osx/src/osx/version.ts` (DEFAULT_VOTING_SETTINGS, MINT_SETTINGS_VERSION)

**Tx Builders:** → `src/features/setup/daoFormation/txBuilders.ts` (`buildCreateDaoArgs`, `buildDeploySignalArgs`)

7-param struct encoding: VotingSettings, TokenSettings, MintSettings, TargetConfig, minApprovals, pluginMetadata, excludedAccounts

Current implementation uses v1.3 MintSettings (2 fields). Supports v1.4 (3 fields with `ensureDelegationOnMint`) via parameter.

### Key Decisions

#### 1. Aragon OSx Address Mapping

Hardcoded per chainId. Server enforces `chainId in SUPPORTED_CHAIN_IDS` before any verification.

**Rule:** Addresses are hardcoded constants (not user-provided). Preflight validates getCode + factory→PSP invariant.

#### 2. Formation Transaction Flow (2 Wallet Txs)

```
┌─────────────────────────────────────────────────────────────────────┐
│ PREFLIGHT (client-side, blocking)                                   │
│ ─────────────────────────────────                                   │
│ 1. Wallet connects, chainId validated against SUPPORTED_CHAIN_IDS   │
│ 2. eth_getCode for DAOFactory, PSP, TokenVotingRepo                 │
│ 3. DAOFactory.pluginSetupProcessor() == PSP                         │
│ 4. Result: PROCEED or ABORT                                         │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (if preflight passed)
┌─────────────────────────────────────────────────────────────────────┐
│ TX 1: CREATE DAO (wallet-signed)                                    │
│ ────────────────────────────────                                    │
│ - DAOFactory.createDao(daoSettings, pluginSettings)                 │
│ - TokenVoting plugin + GovernanceERC20 deployed by Aragon           │
│ - MintSettings mints 1e18 to initialHolder                          │
│ - Capture daoTxHash                                                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ TX 2: DEPLOY SIGNAL (wallet-signed)                                 │
│ ───────────────────────────────────────                             │
│ - Deploy CogniSignal(daoAddress)                                    │
│ - daoAddress derived client-side from TX 1 receipt                  │
│ - Capture signalTxHash                                              │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ SERVER VERIFICATION (server-side)                                   │
│ ─────────────────────────────────                                   │
│ - POST { chainId, daoTxHash, signalTxHash, initialHolder }          │
│ - Server derives ALL addresses from receipts (never trusts client)  │
│ - Server verifies balanceOf + CogniSignal.DAO()                     │
│ - Returns addresses + repo-spec YAML                                │
└─────────────────────────────────────────────────────────────────────┘
```

**Why 2 txs?** Aragon mints GovernanceERC20 in createDao. No custom token deployment needed.

#### 3. TokenVoting Configuration (Exact Parity)

**Constants:** → `packages/aragon-osx/src/osx/version.ts` (DEFAULT_VOTING_SETTINGS)

| Setting                | Value          | Meaning                                  |
| ---------------------- | -------------- | ---------------------------------------- |
| Mode                   | EarlyExecution | Proposals can execute once threshold met |
| supportThreshold       | 500_000        | 50% (1e6 precision)                      |
| minParticipation       | 500_000        | 50% (1e6 precision)                      |
| minDuration            | 3600           | 1 hour minimum voting                    |
| minProposerVotingPower | 1e18           | 1 token to propose                       |

**Never** deviate from these values without explicit governance decision.

#### 4. Server-Side Address Derivation (Security Boundary)

**Receipt Decoders:** → `packages/aragon-osx/src/osx/receipt.ts`

- `decodeDaoAddress()` - Extracts DAO from DAORegistered event (strict, throws if not found)
- `decodePluginAddress()` - Extracts plugin from InstallationApplied event (strict, throws if not found)
- `decodeSignalDeployment()` - Extracts CogniSignal from contractAddress

**Event Topics:** → `packages/aragon-osx/src/osx/events.ts`

- DAORegistered: `0x5c0366e72f6d8608e72a1f50a8e61fdc9187b94c8c0cee349b2e879c03a9c6d9`
- InstallationApplied: `0x6fe58f3e17da33f74b44ff6a4bf7824e31c5b4b4e6c3cb7ac8c1a0c15d4b4f24`

**Server verification flow:**

1. Validate `chainId` against SUPPORTED_CHAIN_IDS (BASE + SEPOLIA only)
2. Derive all addresses from receipts using strict decoders
3. Verify on-chain state: `balanceOf(initialHolder) == 1e18`, `CogniSignal.DAO() == dao`
4. Return repo-spec YAML

**Security:** No fallback heuristics. Missing events throw errors.

#### 5. Import Boundary Enforcement

**Allowed:**

- `src/app/setup/*` → `packages/aragon-osx`
- `packages/setup-cli` → `packages/aragon-osx`

**Forbidden:**

- `packages/aragon-osx` → `src/*`, `services/*`, `node:fs`, `window`
- `packages/setup-cli` → `src/*`, `services/*`

**Why:** Enables future repo split. aragon-osx is pure; runners inject adapters.

#### 6. Repo-Spec Output

**YAML Builder:** → `src/app/api/setup/verify/route.ts` (`buildRepoSpecYaml`)

Populates at formation time:

- `node_id` — random UUID
- `scope_id` — deterministic from node_id
- `cogni_dao.dao_contract`, `plugin_contract`, `signal_contract`, `chain_id`
- `payments.status: pending_activation`

Populated later by `pnpm node:activate-payments` (child node CLI):

- `operator_wallet.address`
- `payments_in.credits_topup.*`
- `payments.status: active`

**Invariants:**

- Server derives DAO/plugin/signal addresses from receipts, not client input
- `chain_id` is string (e.g., `"8453"` not `8453`)
- Canonical path: `.cogni/repo-spec.yaml`
- `payments.status` is explicit — never inferred from field presence

> Current schema: [.cogni/repo-spec.yaml](../../.cogni/repo-spec.yaml)

### Node Publish (Operator-Authored PR)

After Formation returns a verified repo-spec fragment, the **operator** authors the node's monorepo footprint as a single GitHub App–authored pull request — the **Publish** phase (task.5092). There is no GitHub Action and no human PAT: the operator already holds GitHub App installation auth, so it writes the PR directly via the GitHub **Git Data API**.

**Why direct-authoring, not an Action:** a new node is a clone of `nodes/node-template/**` (~1100 files) whose blobs already exist in the repo. A `POST /git/trees` with `base_tree` referencing node-template's tree reuses every unchanged blob by SHA (zero upload); only the renamed files + repo-spec + footprint gens need new blobs — one tree, one commit, one ref, one PR (~40 API calls). Dispatching an Action to re-mint the App token the operator already holds was pure indirection (and broke on `workflow_dispatch`-resolves-on-default-branch, untestable pre-merge).

**Mechanism** (`adapters/server/vcs/github-repo-write.ts` + `shared/node-app-scaffold/`):

1. **Clone tree** — read node-template's tree, build a `POST /git/trees` payload with `base_tree = main`; unchanged paths inherit their existing blob SHA.
2. **Override** — the node-template-referencing files (workspace package names + repo-spec carrying the formed `node_id` / `scope_id` / DAO addresses) get new blobs.
3. **Exclude** (`sha: null` deletes the path from `base_tree`) — the per-node `secrets-catalog.yaml` + `k8s/external-secrets/**` are NEVER cloned (`bug.5086`: a real node copying node-template's catalog re-declares the shared baseline names → `NO_NAME_COLLISIONS` throw, killing `setup:secrets` for every env). A node inherits shared secrets via ESO; no secret value is ever written to the PR.
4. **Footprint gens** — pure-TS ports of the catalog-derived renderers (`caddyfile`, `scope-filters`, `scheduler-endpoints`, the `pnpm-lock.yaml` importer splice, and the per-node AppSet from `scripts/ci/node-applicationset.yaml.tmpl`) regenerate the repo-wide aggregates. Each shares its template with the `scripts/ci/render-*.sh` source of truth, so output is byte-exact and CI's drift gates stay green. The lockfile is read via the uncapped `git/blobs` endpoint (it exceeds the Contents-API 1 MB cap).
5. **Author** — `POST /git/refs` creates the branch; the PR opens under the operator App installation (author = the App, auditable — not `github-actions[bot]`, not a human PAT).

**Invariants:**

- `NO_ACTION_INDIRECTION` — the operator authors the PR itself; it never dispatches a workflow to act on its own behalf.
- `NO_SECRETS_IN_PR` — secrets-catalog + external-secrets are excluded from the cloned tree; values live in OpenBao, inherited via ESO ([secrets-management.md](secrets-management.md)).
- `GENS_ARE_BYTE_EXACT` — every footprint gen shares one template with its `scripts/ci/render-*.sh` source of truth, enforced by the per-gen CI drift gate.

> Verification: the Git Data API tree-assembly is proven by flighting the operator and authoring one throwaway node PR end-to-end (`<node>-test/version == build_sha`).

### Payment Activation (Child Node)

Payment activation runs in the child node's own repo after formation + infra setup. It is a separate trust domain from formation — the child node owns its Privy credentials and operator wallet.

**Entrypoint:** `pnpm node:activate-payments` → `scripts/node-activate-payments.ts`

**Prerequisites:**

- Privy credentials in env (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_SIGNING_KEY`)
- Funded deployer EOA on Base (`DEPLOYER_PRIVATE_KEY`) for Split deployment gas
- `EVM_RPC_URL` for on-chain calls
- `cogni_dao.dao_contract` in repo-spec (from formation)

**Steps (each idempotent):**

1. Verify Privy env configured
2. Resolve operator wallet (0 wallets → create; 1 → use; >1 → error without explicit `OPERATOR_WALLET_ADDRESS`)
3. Deploy Split contract (recipients: operator wallet + DAO treasury from repo-spec)
4. Validate: read deployed Split config back on-chain, verify recipients + allocations match
5. Write repo-spec in place: `operator_wallet.address`, `payments_in.credits_topup.*`, `payments.status: active` (written last, only after on-chain validation succeeds)

**Split controller/admin:** The operator wallet address (from repo-spec). Enables programmatic allocation updates. The founder's connected wallet signs the deployment tx but the operator wallet is the on-chain owner.

**Existing primitives (kept for advanced/recovery use):**

- `scripts/provision-operator-wallet.ts` — standalone Privy wallet creation
- `scripts/deploy-split.ts` — standalone Split deployment
- `scripts/distribute-split.ts` — manual Split distribution trigger

**Trust boundaries:**

- Shared operator repo: formation factory only. Never creates child wallets.
- Child node backend: owns Privy credentials and operator wallet.
- Operator wallet: Split controller/owner (can update allocations programmatically) AND operational spender (recipient).
- Founder wallet: signs the Split deployment tx, does not retain on-chain admin.

### File Pointers

| File                                                    | Purpose                                                |
| ------------------------------------------------------- | ------------------------------------------------------ |
| `packages/aragon-osx/src/aragon.ts`                     | OSx address constants (BASE + SEPOLIA only)            |
| `packages/aragon-osx/src/encoding.ts`                   | TokenVoting struct encoding (viem, v1.3/v1.4 support)  |
| `packages/aragon-osx/src/osx/events.ts`                 | OSx event ABIs + topic constants                       |
| `packages/aragon-osx/src/osx/receipt.ts`                | Strict receipt decoders (throws if events not found)   |
| `packages/aragon-osx/src/osx/version.ts`                | Pinned OSx version constants                           |
| `src/shared/web3/node-formation/aragon-abi.ts`          | Minimal ABIs: DAOFactory, TokenVoting, GovernanceERC20 |
| `src/shared/web3/node-formation/bytecode.ts`            | CogniSignal bytecode + ABI                             |
| `src/features/setup/daoFormation/formation.reducer.ts`  | Pure reducer + types (state machine)                   |
| `src/features/setup/daoFormation/txBuilders.ts`         | Pure tx argument builders                              |
| `src/features/setup/daoFormation/api.ts`                | Server verification API client                         |
| `src/features/setup/hooks/useAragonPreflight.ts`        | Preflight validation hook                              |
| `src/features/setup/hooks/useDAOFormation.ts`           | Thin wiring layer (wagmi → reducer)                    |
| `src/app/api/setup/verify/route.ts`                     | Server derives addresses from receipts, verifies state |
| `src/contracts/setup.verify.v1.contract.ts`             | Zod schemas for verify request/response                |
| `src/app/(app)/setup/dao/page.tsx`                      | Wizard entry point                                     |
| `src/app/(app)/setup/dao/DAOFormationPage.client.tsx`   | Client component with form + flow orchestration        |
| `src/features/setup/components/FormationFlowDialog.tsx` | Modal dialog for progress/success/error states         |
| `scripts/node-activate-payments.ts`                     | Payment activation CLI (child node)                    |
| `scripts/provision-operator-wallet.ts`                  | Standalone Privy wallet provisioning                   |
| `scripts/deploy-split.ts`                               | Standalone Split deployment                            |
| `docs/guides/operator-wallet-setup.md`                  | Operator wallet + payment activation guide             |

### Appendix: Aragon OSx Addresses

**Implementation:** → `packages/aragon-osx/src/aragon.ts` (ARAGON_OSX_ADDRESSES, getAragonAddresses)

**Supported Chains:** BASE (8453), SEPOLIA (11155111)

OSx v1.4.0 deployments. Hardcoded addresses from [cogni-signal-evm-contracts](https://github.com/Cogni-DAO/cogni-signal-evm-contracts).

**Rule:** Addresses are hardcoded constants (not user-provided). Preflight validates getCode + factory→PSP invariant.

## Acceptance Checks

**Formation (manual):**

1. Successfully deployed DAOs on Base mainnet, verified via Aragon app
2. Server derives all addresses from receipts without client-provided addresses
3. `balanceOf(initialHolder) == 1e18` verified on-chain
4. Observability event `SETUP_DAO_VERIFY_COMPLETE` emitted with outcome, chainId, duration
5. Repo-spec output includes `payments.status: pending_activation`

**Payment Activation (manual):**

6. `pnpm node:activate-payments` provisions wallet + deploys Split + writes repo-spec
7. Deployed Split recipients match operator wallet + DAO treasury from repo-spec
8. `payments.status` transitions from `pending_activation` to `active` in repo-spec
9. App starts with activated repo-spec — `container.ts` wires operator wallet + funding chain

## Open Questions

(none)

## Related

- [Node vs Operator Contract](./node-operator-contract.md)
- [Cred Licensing Policy](./cred-licensing-policy.md)
- [Operator Wallet Spec](./operator-wallet.md) — wallet lifecycle, custody, access control
- [Web3 OpenRouter Payments Spec](./web3-openrouter-payments.md) — payment math, funding state machine
- [Node Formation Project](../../work/projects/proj.node-formation-ui.md)
- [Node Formation Guide](../guides/node-formation-guide.md)
- [Operator Wallet Setup Guide](../guides/operator-wallet-setup.md)
- [ROADMAP](../../ROADMAP.md)
