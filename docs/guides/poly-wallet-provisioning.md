---
id: poly-wallet-provisioning-guide
type: guide
title: Poly per-tenant Trading Wallet — Provisioning Runbook
status: draft
trust: draft
summary: Operator-facing runbook for task.0318 Phase B PR #968 — shows what's shipped, explains the three-location split + visible smells, and pins the 5-GH-secret + /profile/API + Loki handshake to exercise on candidate-a.
read_when: Creating the user-wallets Privy app, setting candidate-a secrets, exercising `/profile` or the poly wallet APIs on candidate-a, or reviewing PR #968's architecture.
owner: derekg1729
created: 2026-04-21
verified: 2026-04-21
tags: [poly, polymarket, wallets, multi-tenant, privy, runbook]
---

# Poly per-tenant Trading Wallet — Provisioning Runbook

> Operator-facing runbook for task.0318 Phase B. Covers what's shipped in PR #968 and what to do to exercise it on candidate-a. Pairs with [poly-trader-wallet-port](../spec/poly-tenant-and-collateral.md) (the contract) and [poly-multi-tenant-auth](../spec/poly-tenant-and-collateral.md) (tenant-isolation shape).

## Status at PR #968

| Piece                                                                           | State                                                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `@cogni/poly-wallet` port + types + branded `AuthorizedSigningContext`          | ✅ shipped (`packages/poly-wallet/src/port/`)                            |
| Migration `0030_poly_wallet_connections.sql` + Drizzle schema                   | ✅ shipped                                                               |
| `PrivyPolyTraderWalletAdapter` (`provision`, `resolve`, `getAddress`, `revoke`) | ✅ shipped (node-local: `nodes/poly/app/src/adapters/server/wallet/`)    |
| `authorizeIntent` / `rotateClobCreds`                                           | ✅ shipped                                                               |
| `withdrawUsdc`                                                                  | ⛔ stubbed (throw) — follow-up                                           |
| Bootstrap factory `getPolyTraderWalletAdapter` + real CLOB-creds derivation     | ✅ shipped (`nodes/poly/app/src/bootstrap/poly-trader-wallet.ts`)        |
| `POST /api/v1/poly/wallet/connect` route                                        | ✅ shipped (session-auth, `CUSTODIAL_CONSENT` enforced, 503 on unconfig) |
| `POST /api/internal/node-actions/poly/wallet/rotate-clob-creds` route           | ✅ shipped (signed RBAC action, one-time rotation, no secret egress)     |
| `GET /api/v1/poly/wallet/status` + `/profile` create-wallet control             | ✅ shipped                                                               |
| Agent-actor auth path                                                           | ⛔ explicit 501 until agent-API-key auth lands                           |
| CI secret plumbing (`candidate-flight-infra.yml` + `deploy-infra.sh`)           | ✅ wired for all 5 new secrets                                           |
| Orphan-wallet reconciler (`scripts/ops/sweep-orphan-poly-wallets.ts`)           | ⛔ deferred to follow-up task.0348                                       |
| Component / concurrency / defense-in-depth tests                                | ✅ B2.10 landed: two-tenant adapter round-trip component test            |
| `pnpm check:fast` on branch                                                     | ✅ green (2026-04-21)                                                    |

## Architecture (honest accounting)

There are three places poly-wallet code lives. This **is** a split; reviewers should know why.

```
packages/poly-wallet/                           ← Port + types ONLY
├── src/port/poly-trader-wallet.port.ts         ← PolyTraderWalletPort interface
└── src/index.ts                                ← re-export

nodes/poly/app/src/adapters/server/wallet/      ← Adapter class (node-local)
└── privy-poly-trader-wallet.adapter.ts         ← PrivyPolyTraderWalletAdapter

nodes/poly/app/src/bootstrap/                   ← Factory + env wiring
└── poly-trader-wallet.ts                       ← getPolyTraderWalletAdapter()
```

**Why three locations, not one:**

1. **Port in a shared package** — per `docs/spec/packages-architecture.md`, capability ports live in `packages/` so any runtime (app, future scheduler-worker, future Temporal activities) can depend on them without pulling in node-local deps.
2. **Adapter in `nodes/poly/app/src/adapters/server/wallet/` instead of `packages/poly-wallet/src/adapters/privy/`** — the adapter reads the `poly_wallet_connections` table which lives in `@cogni/poly-db-schema` (itself node-local to poly per task.0324 per-node schema independence). If the adapter lived in the package, the package would import node-local schema — a boundary violation. Co-locating with `@cogni/poly-db-schema` keeps the package boundary clean.
3. **Bootstrap factory in `nodes/poly/app/src/bootstrap/poly-trader-wallet.ts` instead of the adapter file** — ESLint `no-restricted-imports` forbids `@/adapters/**` imports from `nodes/*/app/src/app/**/*` (routes). Routes import from `@/bootstrap/**`; bootstrap imports from `@/adapters/**`. The factory is that bridge.

**Smells a reviewer should know about:**

- **Three locations for one capability is more moving parts than an ideal single-package story.** The reason it isn't one package today is the `@cogni/poly-db-schema` dependency — if/when per-node DB schemas move into their own packages that shared packages can depend on, the adapter could move to `packages/poly-wallet/src/adapters/privy/`. Today it shouldn't.
- **`biome-ignore lint/suspicious/noExplicitAny` on two sites in the adapter** — `createViemAccount` from `@privy-io/node/viem` ships its own viem (`2.48.1`) as a peer-dep; this app pins `2.39.3`. The shapes are runtime-identical but TypeScript rejects the assignment across the two installations. The exact same `const x: any = account` workaround is used in `nodes/poly/app/src/bootstrap/capabilities/poly-trade.ts:696-700` for the operator-wallet signer. Clean fix = unify viem versions, out of scope for this slice.
- **Live CLOB creds now derive at provision time.** The bootstrap keeps `@polymarket/clob-client@5.8.1` isolated in `bootstrap/capabilities/poly-clob-creds.ts` and fails closed if `createOrDeriveApiKey()` cannot mint the tenant wallet's L2 creds. This proves credential bootstrapping, not full trade execution or allowances.
- **`provision` generates the row id via a Postgres roundtrip** (`SELECT gen_random_uuid()::text`) instead of `crypto.randomUUID()`. Noise, should be removed in the test PR.
- **One component test now exists, but only at the adapter / DB layer.** It proves the tenant-safe wallet lifecycle and caught the missing `0030` journal entry. It does **not** prove trade placement, funding, or allowances; live validation on candidate-a is still required.

## Manual green chain for CLOB provisioning

This path is the source of truth for wallet provisioning. Do not replace the
provisioning CLOB boundary unless this manual chain is green with candidate
Privy credentials and the code path matches it.

| Step                                      | Manual green validation                                                                                                                                                              | Code validation                                                                                                                        |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Load candidate user-wallet Privy env   | `.env.candidate-a` provides the user-wallet `PRIVY_USER_WALLETS_*` app id, secret, and signing key.                                                                                  | `getPolyTraderWalletAdapter` reads the same env names and fails closed as `WalletAdapterUnconfiguredError` when missing.               |
| 2. Create or select a Privy server wallet | Privy `walletApi.create` returns an Ethereum wallet address.                                                                                                                         | `PrivyPolyTraderWalletAdapter.provision` creates the tenant wallet before deriving CLOB creds.                                         |
| 3. Prove the wallet can sign typed data   | `@privy-io/node/viem` account signs a small EIP-712 payload successfully.                                                                                                            | `createViemAccount` is the signer source passed into `createOrDerivePolymarketApiKeyForSigner`.                                        |
| 4. Build a viem wallet client on Polygon  | `createWalletClient({ account, chain: polygon, transport: http(POLYGON_RPC_URL) })` succeeds.                                                                                        | `createOrDerivePolymarketApiKeyForSigner` constructs the same viem wallet client.                                                      |
| 5. Derive Polymarket L2 API-key creds     | `@polymarket/clob-client@5.8.1` with `new ClobClient(host, 137, walletClient, ..., useServerTime=true, ..., throwOnError=true)` returns non-empty `key`, `secret`, and `passphrase`. | Unit coverage asserts the provisioning factory uses the v1 positional constructor and normalizes the returned creds before encryption. |
| 6. Reject poisoned credential shapes      | Empty or error-shaped CLOB responses are treated as failure, not stored.                                                                                                             | `normalizePolymarketApiKeyCreds` rejects missing `key`/`secret`/`passphrase`.                                                          |

Known regression boundary:

- The original PR #968 green path used `@polymarket/clob-client@5.8.1` for
  L1 API-key creation.
- PR #1118 moved the provisioning function to
  `@polymarket/clob-client-v2`. With candidate Privy creds, manual validation
  shows that v2 fails before usable creds are produced (`POST /auth/api-key`
  returns upstream 403; `GET /auth/derive-api-key` returns 400), while the v1
  client returns `{key, secret, passphrase}` for the same Privy signing chain.
- Therefore, provisioning must keep the v1 client boundary until v2 is manually
  green for this exact chain. Trading/order placement can still use the v2
  adapter independently.

## Candidate-a exercise path

### 1. Create a NEW Privy app for user wallets (manual, one-time)

**Separate from the operator-wallet Privy app** — `SEPARATE_PRIVY_APP` invariant. Reasons in [poly-trader-wallet-port § Env](../spec/poly-tenant-and-collateral.md).

1. Sign in at <https://dashboard.privy.io> (Cogni-DAO account).
2. "Create app" → name it `cogni-user-wallets-candidate-a` (or similar).
3. Enable **server wallets** for the app.
4. Mint an **authorization key** (format: `wallet-auth:<base64-pkcs8-der>`) — needed for `POST /v1/wallets` signed requests.
5. Record `appId`, `appSecret`, `signingKey`.

### 2. Generate the AEAD key

```bash
openssl rand -hex 32   # 64 hex chars = 32 bytes for AES-256-GCM
```

Choose a key id (e.g., `v1`) — `POLY_WALLET_AEAD_KEY_ID` is stored on every row so you can rotate without breaking existing rows later.

### 3. Set GH env secrets at `candidate-a` scope

```bash
gh secret set PRIVY_USER_WALLETS_APP_ID --env candidate-a
gh secret set PRIVY_USER_WALLETS_APP_SECRET --env candidate-a
gh secret set PRIVY_USER_WALLETS_SIGNING_KEY --env candidate-a
gh secret set POLY_WALLET_AEAD_KEY_HEX --env candidate-a
gh secret set POLY_WALLET_AEAD_KEY_ID --env candidate-a
gh secret set POLY_CLOB_GEO_BLOCK_TOKEN --env candidate-a
```

The first 5 secrets enable wallet creation and encrypted CLOB credential storage. `POLY_CLOB_GEO_BLOCK_TOKEN` is optional, but candidate-a needs it if Polymarket Cloudflare blocks server-side `/auth/api-key` calls; without it, `/api/v1/poly/wallet/connect` returns `error_code: clob_cloudflare_blocked`.

### 4. Flight to candidate-a

After this PR merges to `main`, trigger:

```bash
gh workflow run candidate-flight-infra.yml --ref main
```

Verify:

- **Endpoint cutover** clears (buildsha matches `/readyz.version`).
- Env reached the pod: `pod-exec poly-node-app -- env | grep PRIVY_USER_WALLETS_APP_ID` shows the new id (truncated; don't log the secret).

### 5. Exercise the wallet from candidate-a

Primary path:

1. Open the deployed poly app and sign in normally with your Ethereum wallet.
2. Visit `/profile`.
3. Under **Polymarket Trading Wallet**, click **Create trading wallet**.
4. Confirm the consent copy and click **I understand — create trading wallet**.
5. Expect the row to flip to a connected state with the tenant wallet address and a Polygonscan link.

API fallback:

```bash
SESSION_COOKIE=<your-candidate-a-session>

curl -X POST https://candidate-a-poly.cogni-dao.net/api/v1/poly/wallet/connect \
  -H "Cookie: $SESSION_COOKIE" \
  -H 'Content-Type: application/json' \
  -d '{
    "custodialConsentAcknowledged": true,
    "custodialConsentActorKind": "user",
    "custodialConsentActorId": "<your-user-id>"
  }'
```

**Expected response** (idempotent — second call returns same `connection_id`):

```json
{
  "connection_id": "<uuid>",
  "funder_address": "0x…",
  "requires_funding": true,
  "suggested_usdc": 5,
  "suggested_matic": 0.1
}
```

### 6. Observability handshake

Loki query (replace `<sha>` with the deployed SHA):

```logql
{job="poly-node-app",sha="<sha>"}
  |= "poly.wallet.connect"
  | json
  | line_format "{{.billing_account_id}} {{.connection_id}} {{.funder_address}}"
```

Expect 1 info line per successful request. There should be no stub-creds warning anymore.

### 7. Rotate exposed CLOB credentials

CLOB credentials are per active tenant wallet connection. This is intentionally
not a product UI control: rotation is an OpenFGA-gated node repair action for
incident response or controlled maintenance.

After the fix is deployed, call the authenticated operator gateway:

```bash
curl -fsS -X POST https://cognidao.org/api/v1/nodes/poly/actions \
  -H 'content-type: application/json' \
  --cookie '<authenticated operator session>' \
  -d '{"action":"poly.wallet.rotate_clob_creds","input":{"rotate_all":true}}'
```

The operator checks `node.repair`, signs a 60-second action/body/node-bound
assertion, and posts it to the owning node. The action rotates every non-revoked
`poly_wallet_connections` row, invalidates the process-local trade-executor
cache for each rotated billing account, and returns only counts plus
connection ids/wallet addresses. It never returns API keys, passphrases,
signatures, or raw CLOB request config.

Rotation is only complete when `rotated_count == target_count` and
`failed_count == 0`. If Polymarket blocks API-key creation from the deployed
environment (for example Cloudflare 403), the route must fail with a stable
`error_code` such as `clob_upstream_forbidden`; it has not rolled credentials.
The implementation creates replacement credentials before retiring the old key,
so an upstream create failure does not delete the currently stored key first.

Expected response shape:

```json
{
  "target_count": 1,
  "rotated_count": 1,
  "skipped_count": 0,
  "failed_count": 0,
  "rotated": [
    {
      "billing_account_id": "<uuid>",
      "connection_id": "<uuid>",
      "funder_address": "0x..."
    }
  ],
  "skipped": [],
  "failed": []
}
```

Loki query:

```logql
{job="poly-node-app",sha="<sha>"}
  |= "poly.wallet.rotate_clob_creds.complete"
  | json
  | line_format "status={{.status}} targets={{.target_count}} rotated={{.rotated_count}} failed={{.failed_count}}"
```

Expected log fields are counts/status/duration only. Do not add logs containing
Polymarket auth headers, signatures, passphrases, raw SDK request config, or
raw SDK diagnostic text.

### 8. Deploy-verified handshake

When the provision call returns 200 AND the Loki line appears at the deployed SHA, this slice is exercised. Comment on PR #968:

> `deploy_verified`: candidate-a POST /api/v1/poly/wallet/connect returned 200 with connection_id=… funder_address=… at SHA=…; Loki line seen at …

## Follow-up work before B3 ships

Ordered by blocking priority:

1. **`authorizeIntent` implementation** — requires `poly_wallet_grants` table (B4) + windowed fills-cap queries.
2. **`withdrawUsdc` implementation** — ERC-20 transfer via Privy HSM; requires `WITHDRAW_BEFORE_REVOKE` UX in the dashboard (B3).
3. **Agent-API-key auth path** — unlock `custodialConsentActorKind: "agent"` in the route (currently 501).
4. **Orphan reconciler** — tracked separately in [task.0348](../../work/items/task.0348.poly-wallet-orphan-sweep.md). Keep it out of the v0 trading path.
5. **viem version unification** — drop the two `noExplicitAny` ignores in the adapter once `@privy-io/node`'s peer viem matches the app's.
6. **`UUID round-trip`** — replace `tx.execute("SELECT gen_random_uuid()::text")` with `crypto.randomUUID()`.
7. **Move adapter + port into a single package** once per-node DB schemas are available as shared packages.

## Related

- [poly-trader-wallet-port spec](../spec/poly-tenant-and-collateral.md) — port/adapter contract
- [poly-multi-tenant-auth spec](../spec/poly-tenant-and-collateral.md) — tenant-isolation contract
- [task.0318 work item](../../work/items/task.0318.poly-wallet-multi-tenant-auth.md) — lifecycle carrier
- PR [#968](https://github.com/Cogni-DAO/cogni/pull/968) — the slice covered by this runbook
