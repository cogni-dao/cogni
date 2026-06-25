---
id: design.governance-integration-crawl
type: design
title: "Governance Integration — Crawl Phase"
status: draft
created: 2026-03-11
---

# Governance Integration: Crawl Phase

## Situation

Four separate repos handle Cogni's governance pipeline:

| Repo                        | Function                                                         | Status in cogni-template                                                                    |
| --------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **cogni-git-review**        | AI PR review (gates, checks, comments)                           | **ALREADY PORTED** — `features/review/`, `adapters/server/review/`, `.cogni/repo-spec.yaml` |
| **cogni-git-admin**         | On-chain signal → GitHub actions (merge PR, grant/revoke access) | **NOT ported**                                                                              |
| **cogni-proposal-launcher** | Deep link UI for creating DAO governance proposals               | **NOT ported**                                                                              |
| **Alchemy webhooks**        | Delivers blockchain events to cogni-git-admin                    | **NOT wired**                                                                               |

The review bot is fully operational. What's missing is the **on-chain governance loop**:

```
PR fails review → user clicks "Propose Vote" link → proposal-launcher creates DAO proposal
→ DAO votes → on-chain signal emitted → Alchemy webhook → cogni-template executes GitHub action
```

## Goal (Crawl)

Get the full governance loop working **today** with the existing GitHub App (+ admin permissions). Single app, single deployment, minimal new code.

## What Already Exists (Do NOT Rebuild)

### In cogni-template

- **Webhook receiver**: `/api/internal/webhooks/[source]` — signature verify → normalize → insert receipts
- **`WebhookNormalizer` port**: `@cogni/ingestion-core` — `verify()` + `normalize()` interface
- **GitHub webhook normalizer**: Handles `pull_request`, `issues`, `push`, etc.
- **PR review pipeline**: Full gate orchestration, AI rules, check runs, PR comments
- **`.cogni/repo-spec.yaml`**: Already has `governance` section with contract addresses
- **GitHub App auth**: `review-adapter.factory.ts` creates Octokit from App credentials
- **EVM RPC adapter**: `evm-rpc-onchain-verifier.adapter.ts` — viem client already configured

### In cogni-git-admin (to port)

- Signal parser (~94 lines) — decodes `CogniAction` event from tx logs
- Action executor (~60 lines) — routes signal to handler
- Action handlers (~150 lines) — merge-pr, add-admin, remove-admin
- Alchemy webhook parser (~45 lines) — extracts tx hashes from webhook payload
- HMAC verification (~30 lines) — Alchemy signature check
- GitHub service (~270 lines) — atomic GitHub API operations (merge, collaborator mgmt)

### In cogni-proposal-launcher (to port)

- 3 page routes: `/merge-change`, `/join`, `/propose-faucet`
- Deep link validation library (~100 lines)
- Contract ABIs + encoding (~150 lines)
- wagmi/RainbowKit wallet connection config

## Architecture

### Principle: Extend, Don't Fork

All new code plugs into existing infrastructure:

```
                    ┌─────────────────────────────────────┐
                    │  /api/internal/webhooks/[source]     │
                    │  (existing webhook receiver)         │
                    └──────┬──────────────┬───────────────┘
                           │              │
                    source="github"  source="alchemy"
                           │              │
                   ┌───────▼──────┐ ┌─────▼──────────────┐
                   │ GitHubWebhook│ │ AlchemyWebhook     │  ← NEW
                   │ Normalizer   │ │ Normalizer          │
                   └───────┬──────┘ └─────┬──────────────┘
                           │              │
                    ActivityEvent[]   ActivityEvent[]
                           │              │
                   ┌───────▼──────┐ ┌─────▼──────────────┐
                   │ PR Review    │ │ Signal Executor     │  ← NEW
                   │ Dispatch     │ │ Dispatch            │
                   │ (existing)   │ │ (fire-and-forget)   │
                   └──────────────┘ └────────────────────┘
```

### New Components (3 pieces)

#### 1. Alchemy Webhook Normalizer

**Location**: `apps/operator/src/adapters/server/ingestion/alchemy-webhook.ts`

Implements `WebhookNormalizer` from `@cogni/ingestion-core`:

- `verify()` — HMAC-SHA256 of raw body against `ALCHEMY_WEBHOOK_SECRET`
- `normalize()` — Extract tx hashes from Alchemy `ADDRESS_ACTIVITY` / `MINED_TRANSACTION` webhooks → `ActivityEvent[]`

Register in `bootstrap/container.ts` alongside GitHub normalizer.

#### 2. Signal Executor Feature

**Location**: `apps/operator/src/features/governance/`

```
features/governance/
├── public.server.ts              # barrel export
├── types.ts                      # Signal, ActionResult interfaces
├── services/
│   ├── signal-handler.ts         # orchestrator: parse signal → authorize → execute action
│   └── alchemy-dispatch.ts       # fire-and-forget dispatch from webhook route
├── signal/
│   ├── parser.ts                 # decode CogniAction event from tx receipt (port from git-admin)
│   └── params.ts                 # parameter validation, freshness checks
└── actions/
    ├── merge-pr.ts               # merge:change handler
    ├── grant-collaborator.ts     # grant:collaborator handler
    └── revoke-collaborator.ts    # revoke:collaborator handler
```

**Key decisions:**

- Reuse existing GitHub App credentials (`GH_REVIEW_APP_ID` / `GH_REVIEW_APP_PRIVATE_KEY_BASE64`) — same app, just needs `administration: write` permission added
- Reuse existing `github-auth.ts` adapter for Octokit creation
- Reuse existing `EVM_RPC_URL` env var for viem RPC client (already in `.env.local.example`)
- Signal handler is a pure feature service — no framework dependency

**Dispatch wiring** (in webhook route):

```typescript
// In /api/internal/webhooks/[source]/route.ts — add alongside PR review dispatch:
if (source === "alchemy") {
  dispatchSignalExecution(payload, env, log);
}
```

#### 3. Proposal Launcher Pages

**Location**: `apps/operator/src/app/(governance)/`

```
app/(governance)/
├── merge-change/page.tsx         # DAO proposal to merge PR
├── join/page.tsx                 # Token faucet claim
├── propose-faucet/page.tsx       # Enable faucet permissions
└── layout.tsx                    # wagmi/RainbowKit providers (isolated to governance routes)
```

**Key decisions:**

- Route group `(governance)` keeps wallet providers isolated — no wagmi loaded for non-governance pages
- Port from Pages Router (`useRouter().query`) → App Router (`useSearchParams()`)
- Middleware validation stays in `src/middleware.ts` (existing Next.js middleware)
- Contract ABIs → `apps/operator/src/lib/governance/abis.ts`
- Deep link validation → `apps/operator/src/lib/governance/deeplink.ts`

## Implementation Plan

### Phase 1: Alchemy Webhook Ingestion (~1 hour)

1. **Add env vars** to `.env.local.example`:

   ```
   ALCHEMY_WEBHOOK_SECRET=your-alchemy-signing-key
   ALCHEMY_CHAIN_ID=11155111
   SIGNAL_CONTRACT=0x...
   DAO_ADDRESS=0x...
   ```

2. **Create `AlchemyWebhookNormalizer`** implementing `WebhookNormalizer`:
   - `verify()`: HMAC-SHA256 using `@octokit/webhooks-methods` pattern (or raw crypto)
   - `normalize()`: Parse Alchemy webhook → extract tx hashes → return `ActivityEvent[]` with `source: "alchemy"`, `eventType: "cogni_signal"`
   - Supported events: `ADDRESS_ACTIVITY` (Alchemy's event type for contract logs)

3. **Register in container**: Add `"alchemy"` entry to `getWebhookRegistrations()` map

4. **Add secret resolution**: Add `case "alchemy"` to `resolveWebhookSecret()` in webhook route

5. **Test**: Unit test with captured Alchemy webhook fixture

### Phase 2: Signal Executor (~2 hours)

1. **Port signal parser** from `cogni-git-admin/src/core/signal/parser.ts`:
   - Uses `viem` `decodeEventLog` (viem already in cogni-template deps)
   - Port `CogniSignal.json` ABI
   - Port `parseCogniAction()` function

2. **Port action handlers** (merge-pr, grant-collaborator, revoke-collaborator):
   - Use existing `createOctokitForInstallation()` from `adapters/server/review/github-auth.ts`
   - Wrap Octokit calls for merge, collaborator add/remove
   - Each handler: ~40-50 lines

3. **Create signal handler service**:
   - Receive tx hash → fetch receipt via viem → parse signal → validate (chain, DAO, freshness) → execute action
   - Authorization: MVP allows all (same as cogni-git-admin current state)

4. **Wire dispatch** in webhook route:
   - After Alchemy webhook is verified and normalized, fire-and-forget signal execution
   - Same pattern as `dispatchPrReview()`

5. **Test**: Unit test signal parser + action handlers with mocked Octokit

### Phase 3: Proposal Launcher Pages (~2 hours)

1. **Add web3 dependencies**:

   ```
   pnpm add wagmi @rainbow-me/rainbowkit @tanstack/react-query
   ```

   (viem already present)

2. **Create route group layout** with wagmi/RainbowKit providers

3. **Port 3 pages** (mechanical conversion):
   - `pages/merge-change.tsx` → `app/(governance)/merge-change/page.tsx`
   - `pages/join.tsx` → `app/(governance)/join/page.tsx`
   - `pages/propose-faucet.tsx` → `app/(governance)/propose-faucet/page.tsx`

4. **Port validation middleware**: Add governance route matchers to existing `middleware.ts`

5. **Port shared libs**: `deeplink.ts`, `deeplinkSpecs.ts`, `contractUtils.ts`, `chainUtils.ts`, `abis.ts`

6. **Test**: Manual — open deep links in browser, verify wallet connection + proposal creation

### Phase 4: Wire the Loop (~30 min)

1. **Verify `.cogni/repo-spec.yaml`** has correct `governance` section with contract addresses
2. **Verify review summary** generates correct deep link URLs pointing to `/merge-change` (now local)
3. **Update `base_url`** in repo-spec to point to self (or keep external URL for other repos)
4. **Smee setup** for local Alchemy webhook testing

## Env Vars (New)

| Variable                 | Required        | Purpose                                   |
| ------------------------ | --------------- | ----------------------------------------- |
| `ALCHEMY_WEBHOOK_SECRET` | For governance  | HMAC key for Alchemy webhook verification |
| `SIGNAL_CONTRACT`        | For governance  | CogniSignal contract address              |
| `DAO_ADDRESS`            | For governance  | DAO contract address                      |
| `CHAIN_ID`               | For governance  | EVM chain ID (default: 11155111 Sepolia)  |
| `NEXT_PUBLIC_CHAIN_ID`   | For proposal UI | Chain ID exposed to client                |
| `NEXT_PUBLIC_RPC_URL`    | For proposal UI | Public RPC for wallet connection          |

**Already present**: `EVM_RPC_URL`, `GH_REVIEW_APP_ID`, `GH_REVIEW_APP_PRIVATE_KEY_BASE64`, `GH_WEBHOOK_SECRET`

## GitHub App Permission Changes

Add to existing app:

- `administration: write` — needed for collaborator management (grant/revoke)
- `contents: write` — needed for PR merge (may already be present for review)

No new app needed. Same webhook URL. Same credentials.

## Dependencies (New)

| Package                  | Already in template? | Purpose                 |
| ------------------------ | -------------------- | ----------------------- |
| `viem`                   | YES                  | EVM RPC, event decoding |
| `zod`                    | YES                  | Validation              |
| `@octokit/rest`          | YES (via octokit)    | GitHub API              |
| `wagmi`                  | NO — add             | Ethereum wallet hooks   |
| `@rainbow-me/rainbowkit` | NO — add             | Wallet connection UI    |
| `@tanstack/react-query`  | YES                  | Data fetching for wagmi |

## Walk / Run (Future Phases)

### Walk: Operator Repo + Separate Apps

- Dedicated operator repo with different GitHub App (reduced permissions)
- cogni-git-admin as standalone service with its own app credentials
- Webhook routing: Alchemy → operator repo → dispatch to appropriate service
- Benefit: principle of least privilege

### Run: Full Governance Stack

- Multi-chain support (mainnet + L2s)
- Database-backed DAO authorization allowlist (not hardcoded env vars)
- Nonce replay protection
- Multi-VCS support (GitLab, Radicle)
- Governance dashboard in cogni-template UI
- Proposal status tracking + cross-linking (PR ↔ proposal)

## Risks

| Risk                                     | Mitigation                                              |
| ---------------------------------------- | ------------------------------------------------------- |
| Single GitHub App with broad permissions | Crawl-only; Walk phase separates apps                   |
| No nonce replay protection in MVP        | Acceptable for testnet; add in Walk                     |
| No DAO authorization allowlist           | MVP hardcodes single DAO via env; Walk adds DB          |
| wagmi bundle size impact                 | Route group isolation — only loaded on governance pages |

## File Count Estimate

| Component               | New files                                     | Lines (approx)   |
| ----------------------- | --------------------------------------------- | ---------------- |
| Alchemy normalizer      | 2 (adapter + test)                            | ~120             |
| Signal executor feature | 7 (types, parser, params, 3 actions, handler) | ~450             |
| Dispatch wiring         | 1 (modify webhook route)                      | ~20              |
| Proposal launcher       | 8 (3 pages, layout, 4 libs)                   | ~600             |
| Env/config updates      | 2 (modify existing)                           | ~30              |
| **Total**               | **~20 files**                                 | **~1,220 lines** |
