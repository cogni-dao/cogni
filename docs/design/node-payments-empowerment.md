---
id: design.node-payments-empowerment
type: design
title: Node Payments Empowerment — Non-Custodial Wallet/Split/Funding Provisioning
status: draft
trust: draft
summary: The exact e2e flow by which the operator's Privy app empowers another node (or lightweight scope) with its OWN wallet, Split, and OpenRouter top-up — non-custodially (operator cannot move node funds) — plus the v0 fastest-functional path and the roadmap to multi-tenant scopes per agent-registry.
read_when: Building or reviewing payments-activation v0, node-wallet provisioning, the activate(nodeId) flow, or the scope/tenant payments roadmap.
owner: derekg1729
created: 2026-06-24
tags: [payments, web3, wallet, privy, splits, custody, scopes, agent-registry]
---

# Node Payments Empowerment

> Generalizes `design.node-payments-activation` from "the operator activates its own payments" to "the operator empowers ANY node/scope with its own non-custodial money loop." This doc is the **template + the proof**: it nails the as-built operator chain, then the exact non-custodial generalization, the minimal v0, and the scope roadmap. Refines/reviews the payments-activation v0 PR.

## TL;DR

- **As-built operator chain works** but is NOT a model for non-custody: the operator wallet is created with **no `owner`** (`provision-operator-wallet.ts:36`), so `PRIVY_APP_SECRET` + `PRIVY_SIGNING_KEY` in the operator's env can move its funds. Fine for the operator (it owns itself); fatal if copied to node wallets.
- **The non-custodial primitive is real and pinned-version-verified:** `@privy-io/node@0.10.1` `wallets().create({ owner: { public_key } })` ties a wallet to a **P-256 key-quorum**; signing requires `authorization_context.authorization_private_keys = [<that P-256 private key>]`. If the operator never holds that private key, the operator's `PRIVY_APP_SECRET` alone **cannot** sign — proven non-custody.
- **v0 fastest path:** operator generates a per-node P-256 keypair, creates the node wallet `owned by` the node's public key, deploys the node's Split, writes `node_wallet`/`payments_in` into the **node's own repo** `.cogni/repo-spec.yaml` via the GitHub-App PR precedent, and delivers the **P-256 private key** as the node's `PRIVY_SIGNING_KEY` secret (the node also needs its own `PRIVY_APP_ID/SECRET`, or a shared-app read path — see §3 open question). Then run the existing `$2` money e2e against the node's deployment.
- **Two correctness bugs the v0 PR MUST fix:** (1) terminology `operator_wallet` → `node_wallet`; (2) `hashSplitV2` in the SDK is **`encodePacked`, not `abi.encode`** — wrong hash (PR #1832). Evidence below.

---

## 1. As-built operator empowerment (the template)

### The money chain, end to end

**Inbound (credits) — operator-free per node once activated:**

1. `createIntent` (`paymentService.ts:117`) reads `getPaymentConfig()` from repo-spec (`chainId`, `receivingAddress` = the Split), then `paymentRailGuard.assertReady()` proves the on-chain Split matches repo-spec economics before any intent is minted (fail-closed).
2. User sends USDC to the Split on Base. `submitTxHash` → `verifyAndSettle` (`paymentService.ts:401`) verifies on-chain (sender match, amount, token, `to`), then `confirmCreditsPayment` (`creditsConfirm.ts:44`) mints user credits (idempotent on `chainId:txHash`) + optional system-tenant revenue-share bonus.

**Outbound (funding) — Privy signs, on CREDITED:**

3. On the `CREDITED` transition, `runPostCreditFunding` (`paymentService.ts:524`) runs inline (never throws): treasury settlement (`distributeSplit`) + OpenRouter top-up (`fundOpenRouterTopUp`). If outbound ports are absent it logs `payments.settlement_skipped` (bug.5087, `paymentService.ts:534`) — credits minted, USDC stuck in Split.

### Which secret the operator holds, and how it signs

| Secret                                  | Held where today                                                             | What it does                                                                                                                                                                   |
| --------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PRIVY_APP_ID`                          | operator env (catalog `source: human`, A1, `infra/secrets-catalog.yaml:929`) | identifies the Privy app                                                                                                                                                       |
| `PRIVY_APP_SECRET`                      | operator env (`:938`)                                                        | authenticates app→Privy API (list/create wallets, submit txns)                                                                                                                 |
| `PRIVY_SIGNING_KEY` (`wallet-auth:...`) | operator env (`:947`)                                                        | the **authorization private key** passed as `authorization_context.authorization_private_keys` on every `sendTransaction` (`privy-operator-wallet.adapter.ts:107,221,298,343`) |

The adapter holds **no raw EVM key** (`KEY_NEVER_IN_APP`). Privy's HSM holds the EVM key; the app authorizes use of it by signing the API request with the P-256 authorization key. The port is **intent-only** (`NO_GENERIC_SIGNING`): `OperatorWalletPort` exposes only `distributeSplit` + `fundOpenRouterTopUp` (`operator-wallet.port.ts:69`) — no `signTransaction(calldata)` surface.

### Why this is NOT non-custodial (and why that's OK for the operator)

`provision-operator-wallet.ts:36` calls `client.wallets().create({ chain_type: "ethereum" })` with **no `owner`**. Per the pinned SDK, a wallet with no owner is controlled by the app's default authorization (the app secret + any signing key). So whoever holds `PRIVY_APP_SECRET` (+ signing key) can move the operator wallet. The operator IS the operator, so self-custody is correct. **The moment we provision a node's wallet this way and hand the keys to the node, OR keep them in the operator, custody breaks** — either the operator is custodial of node funds, or the node and operator can both move them.

### What makes it "live" (container wiring)

`container.ts` builds `operatorWallet` (`:770`) ONLY when `!isTestMode` AND `PRIVY_APP_ID/SECRET/SIGNING_KEY` present AND `operator_wallet.address` in repo-spec AND `cogni_dao.dao_contract` present AND `getPaymentConfig()` present AND `EVM_RPC_URL` set — else `undefined` (graceful skip). `providerFunding` additionally requires `OPENROUTER_API_KEY` and enforces `MARGIN_PRESERVED` (`:868–884`): `markup × (1 − fee) > 1 + revenueShare`, else it throws at boot. `paymentRailGuard` (`:820`) fail-closes intents when repo-spec/Split disagree. `isTestMode` swaps every port for fakes — **no real money path in test**.

---

## 2. Generalized node/scope empowerment (non-custodial), e2e

> Terminology: this is the **node's wallet** (`node_wallet`), never "operator wallet." The operator is a _provisioner_, not a custodian.

### The non-custodial primitive — verified against `@privy-io/node@0.10.1`

`WalletCreateParams` (`resources/wallets/wallets.d.ts:947`):

```ts
create({
  chain_type: "ethereum",
  owner: { public_key: "<base64 SPKI P-256 public key>" }, // PublicKeyOwner, :988
});
```

`owner.public_key` is a **P-256 public key, base64-DER (SPKI)** — generated by `generateP256KeyPair()` (`lib/cryptography.d.ts`), which returns `{ publicKey (SPKI), privateKey (PKCS8) }`. Setting `owner` creates a key-quorum keyed by that public key (`owner_id` on the wallet, `:188`). Thereafter, signing requires `authorization_context.authorization_private_keys: ["<the PKCS8 private key>"]` (`lib/authorization.d.ts:16`; example in `cryptography.d.ts`).

**Proof of non-custody:** if the operator generates the keypair, hands the **private** key to the node, and **never retains it**, then the operator's `PRIVY_APP_SECRET` can authenticate to Privy (list wallets, read) but **cannot produce a valid `authorization-signature` for a wallet owned by a quorum it has no private key for** → cannot move node funds. The EVM key never leaves Privy's HSM (`KEY_NEVER_IN_APP`); the _authorization_ to use it is gated by a key the operator doesn't hold. This is `WALLET_CUSTODY` satisfied by construction, with no per-node EVM key material anywhere.

> ⚠️ **Unverified at runtime — must be exercised before trusting.** That the SDK _rejects_ a `sendTransaction` for an owned wallet when the operator's own (non-owner) signing key is supplied is the security-load-bearing assertion. The types support it; **no test in this repo proves it.** v0 MUST add a negative test: operator app secret + wrong/absent owner key → Privy 4xx, NOT a broadcast.

### Step-by-step (operator provisions node N)

```
operator app (PRIVY_APP_SECRET)                          node N (its own deployment)
──────────────────────────────                          ───────────────────────────
1. kp = generateP256KeyPair()  (in-memory, ephemeral)
2. wallet = create({chain_type:"ethereum",
        owner:{public_key: kp.publicKey}})  ──HSM──▶  EVM wallet, owned by kp's quorum
3. deploy Split V2 (controller = wallet.address,
   recipients sorted asc: [node_wallet, treasury],
   allocations from calculateSplitAllocations)
4. GitHub-App PR into N's OWN repo .cogni/repo-spec.yaml:
     node_wallet.address, payments_in.credits_topup.*,
     payments.status: active   (write last)
5. deliver kp.privateKey as N's secret PRIVY_SIGNING_KEY  ───secrets path──▶  N's env (OpenBao/ESO)
6. DISCARD kp.privateKey in operator memory   ◀── non-custody hinges on this
                                                         7. N's container builds node_wallet adapter
                                                            (its own PRIVY_APP_*/SIGNING_KEY) →
                                                            distributeSplit + fundOpenRouterTopUp
```

- **Split controller = node wallet** so only the node can re-configure/distribute its Split; the operator is not a recipient and not the controller.
- **Economics 95/5:** `markup_factor 1.10803324099723`, `revenue_share 0` → `calculateSplitAllocations` yields node ≈ 100% of the post-fee margin to the node wallet (which funds OpenRouter) with the DAO treasury share derived from `revenue_share` (0 today). Verify the resulting allocations against the deployed Split via the (fixed) hash check.

### The secret, precisely

- **Which secret:** the node's `PRIVY_SIGNING_KEY` = the **PKCS8 P-256 private key** of the wallet's owner quorum. This is the ONLY thing that authorizes spending the node's wallet.
- **Where it lives per env:** OpenBao `cogni/<env>/<node>/PRIVY_SIGNING_KEY` → ESO → k8s `<node>-env-secrets` → `process.env` (`secrets-add-new.md` runtime path). Catalog tier A1, `appliesTo: payments`, `source: human` today (`secrets-catalog.yaml:947`).
- **How it's delivered (v0 vs hardening):**
  - **v0:** operator generates the keypair and writes the private key via the self-serve secrets API (`POST /api/v1/nodes/<id>/secrets`, `secrets_manager` grant) to the node's env on the operator that serves that env. This means **the operator briefly handles the private key in process** (generate → write → discard). Acceptable for v0 _only if discarded and never logged_; note it weakens the "operator never sees the key" claim to "operator never _retains_ the key."
  - **Hardening (task.5081):** the node generates its **own** P-256 keypair locally and gives the operator only `owner.public_key` at create time; the private key is born in the node's OpenBao namespace and the operator never touches it. This is the only fully-clean non-custody. **Recommend the v0 PR leave a seam for "owner public_key supplied by caller" so the hardened path is a config flip, not a rewrite.**

### Open question — shared Privy app vs per-node app

`fundOpenRouterTopUp`/`distributeSplit` call `client.wallets().sendTransaction(walletId, …)`. `walletId` is discovered via `wallets().list()` matching the repo-spec address (`privy-operator-wallet.adapter.ts:135`). To run from N's deployment, N's container needs `PRIVY_APP_ID/SECRET` too. Two options:

- **(A) Shared app:** all nodes use the operator's `PRIVY_APP_ID/SECRET`; non-custody still holds because spending needs the per-node owner key. Simpler, but the shared app secret is now in every node env (blast radius). **Recommended for v0.**
- **(B) Per-node app:** each node has its own Privy app. Cleanest isolation; heaviest setup. Defer.
- Either way, the wallet is owned by the node's P-256 quorum, so `APP_SECRET` does not grant spend.

---

## 3. v0 — fastest functional, one real non-operator node

**Goal:** one non-operator node's full loop (USDC → its Split → its wallet → OpenRouter top-up) proven with real $ on Base on a real deployment, reusing the operator precedent + the `activate(nodeId)` flow.

**Build:**

1. `activate(nodeId)` operator action (idempotent), advancing `published → wallet_ready → payments_ready → active` (state machine `state-machine.ts:34–36`):
   - `wallet_provisioned`: `generateP256KeyPair()` + `wallets().create({owner:{public_key}})` → node wallet address. Write address into node row + (later) repo-spec.
   - `payments_configured`: deploy Split (controller = node wallet), reusing `calculateSplitAllocations` + `deploy-split.ts` logic. **Use the corrected keccak256 hash (see §5), not SDK `hashSplitV2`.**
   - `activation_published`: GitHub-App PR into the **node's own repo** `.cogni/repo-spec.yaml` (precedent: `nodes/[id]/publish/route.ts` opens App PRs into node repos) writing `node_wallet.address`, `payments_in.credits_topup.{provider,receiving_address=Split,allowed_chains,allowed_tokens}`, `payments.status: active` **last** (per `PAYMENTS_ACTIVE_REQUIRES_ALL`, node-formation.md:93).
   - Deliver `PRIVY_SIGNING_KEY` (the owner private key) to the node's env via self-serve secrets; deliver shared `PRIVY_APP_ID/SECRET` (option A) the same way; discard the private key in operator memory.
2. Run the existing `$2` money e2e (`tests/external/money/openrouter-topup-e2e.external.money.test.ts`) against the node's deployed URL (deployment-portable per payments-activation §4).

**Deferred (safe):**

- OpenBao per-node namespace isolation / node-self-generated keys (task.5081) — v0 accepts operator-transient key handling.
- `@cogni/dao-formation` extraction for self-hosted wizard (only when a node needs self-serve formation).
- Per-node Privy app (option B).
- `SIMULATE_BEFORE_BROADCAST` app-side hook (Privy handles infra-side; adapter notes this, `:277`).

**Must NOT defer:** the keccak256 hash fix and the `node_wallet` rename (both poison the repo-spec contract if shipped wrong) — see §5.

---

## 4. Roadmap to scopes (agent-registry vision)

The end state (`agent-registry.md` + `tenant-connections.md`): spawn a **scope** — own dolt, own agents, own payments — **without its own node app**, as a tenant inside a shared app.

| Dimension    | Today: full node app                      | Target: lightweight scope                                                                                                                                                  |
| ------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity     | `node_id` per repo                        | `scope_id` + `scope_key` within a node (repo-spec already carries both, `repo-spec.yaml:8–9`)                                                                              |
| Code/deploy  | own repo + image + overlay                | none — runs inside a shared (operator or host) app                                                                                                                         |
| Data         | own Postgres/Doltgres                     | RLS-scoped rows by `billing_account_id`/`scope_id` in the shared DB; agent-registry table is already tenant-scoped (`agent-registry.md:76`)                                |
| Agents       | `@cogni/<node>-graphs`                    | `agent_registrations` per scope (`NODE_EFFECTIVE_CATALOG`), offchain-first (`OFFCHAIN_FIRST`, `NO_SECRETS_ON_CHAIN`)                                                       |
| Payments     | repo-spec `node_wallet` + container ports | per-scope wallet (same Privy owner-key primitive) + per-scope Split; config NOT in a repo (no repo) → in a **scopes table**, not `.cogni/repo-spec.yaml`                   |
| Runtime auth | env secrets per node                      | `connectionId` broker (`tenant-connections.md`): scope's signing key is a tenant-scoped **connection**, AEAD-encrypted, resolved at invocation — never in graph state/args |

### Progression

1. **v0 (this doc):** full node app per node; per-node owner key in env. Proves the non-custodial primitive once.
2. **Repo-spec → table:** payment config that today lives in `.cogni/repo-spec.yaml` moves (for scopes) into a `scopes`/`scope_payments` table keyed by `scope_id`. The container's `getPaymentConfig()` becomes scope-aware (resolve by `scope_id`, not a single file). This is the load-bearing refactor — the money chain is already port-based, so it generalizes if the _config source_ does.
3. **Owner key → connection:** the per-scope Privy owner private key stops being a pod env var and becomes a **connection** (`connections` table, AEAD, `credential_type: privy_authorization_key`). Spending resolves it at invocation via the broker with grant intersection (`GRANT_INTERSECTION_BEFORE_RESOLVE`) — never custodial, never in state. This unifies wallet custody with tool auth under ONE mechanism.
4. **Agents per scope:** `AgentIdentityPort.register()` from the scope's effective catalog; optional ERC-8004 publication is export-only. No code per scope.
5. **Dolt per scope:** scope's knowledge is RLS-partitioned in the shared Doltgres (or a per-scope Dolt DB minted like the per-node DoltHub mirror in `publish/route.ts`), addressed by `scope_id`.

**Custody for a scope with no app of its own:** the wallet is owned by a P-256 quorum whose private key lives encrypted in `connections` (host app holds AEAD key, NOT the plaintext owner key — and even plaintext owner key ≠ EVM key; EVM key is in Privy HSM). The host app can decrypt the owner key only inside the broker at invocation, bound to the scope's `billing_account_id`/grant — so a scope's funds are spendable only by an authorized graph run for that scope. **This is strictly stronger than v0's env-held key.**

### Open questions (roadmap)

- Where exactly does scope payment config live (`scopes` table shape) and how does `getPaymentConfig()` become `getPaymentConfig(scopeId)` without breaking the single-file node path? (Needs a spec.)
- `connections` today is for tool OAuth/app-passwords; adding a `privy_authorization_key` credential type that the _payments_ path (not toolRunner) resolves crosses two subsystems — needs `tenant-connections.md` amendment.
- Is one Split per scope economical (gas to deploy N Splits) or should scopes share a parameterized Split? Unresolved.

---

## 5. Reviewing the payments-activation v0 PR — checklist

Apply this to the in-flight `activate(nodeId)` PR.

### MUST get right now (poisons the contract otherwise)

- [ ] **keccak256, not `encodePacked`.** `split-payment-rail-guard.adapter.ts:15` imports `hashSplitV2` from `@0xsplits/splits-sdk/utils`. Verified impl (`node_modules/@0xsplits/splits-sdk/dist/src/utils/index.js:264`):
  ```js
  keccak256(
    encodePacked(
      ["address[]", "uint256[]", "uint256", "uint16"],
      [accounts, allocs, total, fee]
    )
  );
  ```
  On-chain 0xSplits V2 `splitHash()` is `keccak256(abi.encode((address[],uint256[],uint256,uint16)))` — **`encodeAbiParameters`, not `encodePacked`**, and over the struct. These differ. The guard's `expectedSplitHash` (`:101`) and `deploy-split.ts` MUST use the corrected hash (PR #1832). **If activation deploys a Split and then validates with the wrong hash, every node's first intent fail-closes `SPLIT_CONFIG_MISMATCH`** — or worse, the operator's existing split only "matches" because both deploy and check use the same wrong function (latent until the SDK is fixed). Pin the fix; add a test asserting computed hash == on-chain `splitHash()` for a real deployed Split.
- [ ] **`operator_wallet` → `node_wallet` rename.** Surfaces: repo-spec field (`repo-spec.yaml:19`), `getOperatorWalletConfig()` + `operatorWalletConfig` (`container.ts:769`), `OperatorWalletPort`/`PrivyOperatorWalletAdapter`/`PrivyOperatorWalletConfig`, `provision-operator-wallet.ts` output strings, `node_wallet`/Split UI copy. **Migration concern:** the operator's live repo-spec uses `operator_wallet`; the schema/loader must accept both (alias) or the operator's own payments break on deploy. Recommend: schema accepts `node_wallet` with `operator_wallet` as a deprecated alias for one release; operator repo-spec migrated in the same PR.
- [ ] **Non-custody is actually enforced, not assumed.** The PR must create node wallets with `owner: { public_key }` (NOT bare `create({chain_type})` like the operator script). Add the negative test (§2): operator secret without the owner key cannot sign an owned wallet.
- [ ] **Write-back targets the NODE's repo**, not root or operator (`SINGLE_HOME`): App PR into `nodes/<x>` repo `.cogni/repo-spec.yaml`, `payments.status: active` written last (`PAYMENTS_ACTIVE_REQUIRES_ALL`).
- [ ] **Idempotency:** re-running `activate(nodeId)` detects existing wallet (via `wallets().list()` match) + Split + repo-spec and is a no-op.

### Safe to defer (call out explicitly, don't block)

- [ ] OpenBao per-node namespace / node-self-generated owner key (task.5081). v0 may have the operator generate + transiently handle the key **iff** it discards and never logs it. Leave the `owner.public_key`-supplied-by-caller seam.
- [ ] Per-node Privy app (option B) — v0 uses shared app (option A).
- [ ] Scope/table-based config — node-app path only for v0.
- [ ] `@cogni/dao-formation` extraction.

### Watch-outs

- `settlement_skipped` (`paymentService.ts:534`) must NOT fire on the activated node — it means outbound ports didn't wire (missing `OPENROUTER_API_KEY` / `EVM_RPC_URL` / node wallet). The e2e asserting an OpenRouter credit delta catches this.
- `MARGIN_PRESERVED` (`container.ts:878`) throws at boot if `markup × (1−fee) ≤ 1 + revenueShare`. With `markup 1.10803…`, `fee 0.05`, `revenueShare 0`: `1.10803 × 0.95 = 1.0526 > 1` ✓. Verify the activated node's repo-spec carries these exact values or boot fails.

---

## Invariants honored

- **WALLET_CUSTODY** — operator never retains the node's owner private key; wallet owned by node's P-256 quorum.
- **KEY_NEVER_IN_APP / INTENT_ONLY_CALLERS / NO_GENERIC_SIGNING** — EVM key in Privy HSM; port is `distributeSplit`+`fundOpenRouterTopUp` only.
- **NO_SECRETS_ON_CHAIN** — Split/wallet addresses on chain; keys never.
- **SINGLE_HOME** — node payments config in the node's own `.cogni/repo-spec.yaml`.
- **OFFCHAIN_FIRST** (roadmap) — scope agents/payments work without chain; on-chain is export.

## Pinned-version unknowns (do not guess — verify)

1. **Runtime non-custody assertion** — that an owned wallet rejects a `sendTransaction` lacking the owner key. Types support it (`@privy-io/node@0.10.1`); no repo test proves it. **Add one.**
2. **`hashSplitV2` fix shape** — confirm PR #1832's corrected encoding equals on-chain `splitHash()` against a freshly deployed Split before depending on it for activation.
3. **Shared-app `walletId` discovery at scale** — `wallets().list()` paginated scan (`adapter.ts:135`) is O(N wallets) per node boot; fine for v0, revisit when N grows (filter by `authorization_key`, `WalletListParams:1011`).

## Related

- [design.node-payments-activation](./node-payments-activation.md) — operator self-activation + $2 e2e (this generalizes it)
- [agent-registry.md](../spec/agent-registry.md) · [tenant-connections.md](../spec/tenant-connections.md) · [operator-wallet.md](../spec/operator-wallet.md) · [node-formation.md](../spec/node-formation.md) · [identity-model.md](../spec/identity-model.md)
- `packages/operator-wallet/*` · `nodes/operator/app/src/features/payments/*` · `scripts/{provision-operator-wallet,deploy-split}.ts`
