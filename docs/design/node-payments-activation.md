---
id: design.node-payments-activation
type: design
title: Node Payments Activation — Wizard, Seamless Activation, Live-Money E2E
status: draft
trust: draft
summary: How DAO formation (operator-hosted wizard) and payment activation work for nodes launched inside the monorepo — who owns the wizard, how activation becomes one seamless step, how ongoing per-node operations run without binding the operator, and the exact $2 live-money e2e test against a deployment.
read_when: Working on node formation/activation, the operator setup wizard, operator-wallet provisioning, the external:money tests, or testing the payment chain live in a deployment.
owner: derekg1729
created: 2026-05-31
updated: 2026-05-31
tags: [web3, wallet, setup, payments, testing]
---

# Node Payments Activation

> Reviewed design. Refines `proj.node-formation-ui` (lifecycle) + `proj.ai-operator-wallet` (the money chain). Implementation tasks live in those projects; this doc is the through-line + the live-money test plan.

## Outcome

Success is when a founder forms a DAO through the operator-hosted wizard, runs **one** activation step for a monorepo node, and that node's payment loop (USDC → Split → node wallet → OpenRouter top-up) is proven live with a **$2** real-money e2e run against the deployed build — with the operator never holding the node's keys and the node free to split into its own repo.

## 1. The wizard flow (as-built) + who owns it

**Formation (operator-hosted UI):**

1. Founder opens `cognidao.org/setup/dao` — `nodes/operator/app/src/app/(app)/setup/dao/` (`DAOFormationPage.client.tsx`, `features/setup/daoFormation/txBuilders.ts`).
2. Founder signs **2 txs** from their own wallet: `createDao` (Aragon DAO + GovernanceERC20) and `deployCogniSignal`.
3. `POST /api/setup/verify` derives DAO/plugin/token/signal addresses from the receipts (never trusts client) → returns a repo-spec fragment with `cogni_dao.*` + `payments.status: pending_activation`.

**Activation (today, manual):** `setup/dao/payments` page + `scripts/provision-operator-wallet.ts` + `scripts/deploy-split.ts` + a hand-edit of repo-spec.

### Is the operator the only node with the wizard? — Right for v0, and it does NOT bind the operator.

- **Wizard UI** (`setup/dao/*` pages): **operator only** — verified, no UI in node-template/resy.
- **`/api/setup/verify` endpoint**: **every node ships it** (`nodes/{operator,resy,node-template}/app/src/app/api/setup/verify/route.ts`).
- **Why this is fine:** the founder signs every formation tx; the operator never touches keys or treasury (`WALLET_CUSTODY`). The operator-hosted wizard is a **stateless tool**, not custody. A node launched in the monorepo forms its DAO via the operator UI, then activates its _own_ wallet/Split.
- **The one gap (graduation, not v0):** the formation feature (`txBuilders` + reducer + verify) is app-local in operator, so a node that **splits into its own repo** cannot self-host the wizard without copying code (divergence risk per `repo-sync-contract`). Graduation = extract `@cogni/dao-formation` so any sovereign node can mount the wizard. Deferred until a node actually needs self-serve formation.

## 2. Seamless activation — `activate(nodeId)`

Replace the manual 3-step (provision-wallet → deploy-split → hand-edit repo-spec) with **one idempotent operator step**, parameterized by node:

1. Create the node's **own** Privy wallet (own `walletId`) → store the secret in the **node's** secret namespace (OpenBao, task.5081 — not a shared key).
2. Deploy the node's Split (controller = **node's** wallet; ~92.1% node / ~7.9% DAO treasury).
3. Write `node_wallet.address` + `payments_in.credits_topup.receiving_address` (the Split) + `payments.status: active` into **`nodes/<x>/.cogni/repo-spec.yaml`** (not root).

Idempotent: re-running detects an existing wallet/Split and is a no-op. This is the "Founder clicks Launch → live" gap in `proj.node-formation-ui`.

**Naming fix:** rename `operator_wallet` → `node_wallet` in the node-spec. The word "operator" is the sole source of the "is the operator bound?" confusion — it is the node's own wallet.

## 3. Ongoing operations — node-local, operator-free

The runtime loop is entirely node-local and does **not** route through the Cogni operator:

```
user USDC → node's Split → 92.1% node_wallet / 7.9% DAO treasury
node_wallet → fundOpenRouterTopUp(intent) → OpenRouter credits (typed intents only; Privy signs)
```

Each node owns its wallet/Split/DAO; the operator is not in the loop. The per-node `tests/external/money/openrouter-topup-e2e.external.money.test.ts` is the regression guard for this loop.

## 4. Exact $2 live-money e2e test

The test already exists and spends **$2** (`MIN_PAYMENT_CENTS`): `nodes/<node>/app/tests/external/money/openrouter-topup-e2e.external.money.test.ts`, run via `pnpm -F <node> test:external:money`. It: SIWE-logs-in → `POST /payments/intents` → sends real USDC on Base → `submit` → polls `CONFIRMED` → asserts `provider_funding_attempts`, TigerBeetle deltas, and OpenRouter credit increase.

### Steps to run the FULL flow against a deployment

1. **Form** the test node's DAO via the operator wizard → commit `cogni_dao.*` to `nodes/<x>/.cogni/repo-spec.yaml`.
2. **Activate** via `activate(nodeId)` → wallet + Split + `payments.status: active` → deploy the build.
3. **Fund** `TEST_WALLET_PRIVATE_KEY` with ~$2 USDC + a little ETH for gas on Base.
4. Set env: `TEST_BASE_URL=https://<deployed-node-url>`, `OPENROUTER_API_KEY`, `EVM_RPC_URL`, plus `DATABASE_SERVICE_URL` + `TIGERBEETLE_ADDRESS` reachable for assertions (see blocker below).
5. Run `pnpm -F <node> test:external:money`.
6. Assert: funding row `funded`, TB deltas exact, OpenRouter credits up.

### Tweak (DONE) — deployment-portable money test

The test was local-stack-coupled (read Postgres + TigerBeetle directly via `DATABASE_SERVICE_URL`/`TIGERBEETLE_ADDRESS`). Refactored so those become **optional**:

- **Always runs** (portable, any `TEST_BASE_URL`): SIWE login → `intent` → real USDC transfer → `submit` → poll `CONFIRMED` → **OpenRouter credit delta**. SIWE login mints the user on first contact, so no DB pre-insert is needed against a deployment.
- **Deep assertions** (Postgres `provider_funding_attempts` + exact TigerBeetle deltas) run **only when** `DATABASE_SERVICE_URL` + `TIGERBEETLE_ADDRESS` are reachable (local dev:stack).

Chosen over adding a new read endpoint: zero new API surface, the loop is still proven end-to-end against a deployment by `CONFIRMED` + real OpenRouter credit increase. (Files: `nodes/operator/app/tests/external/money/openrouter-topup-e2e.external.money.test.ts`, `vitest.external-money.config.mts`.) A richer HTTP read of funding/ledger deltas is a future hardening, not required for the v0 live run.

## 5. Privy multi-node custody — skip OpenBao (task.5081) for v0

`@privy-io/node`, one Privy app (`PRIVY_APP_ID/SECRET/SIGNING_KEY`), `client.wallets().create()`. The operator node is **already activated**, so the first $2 e2e needs no multi-node Privy work. For the eventual multi-node case:

- **Programmatic path (one app, N wallets, non-custodial):** the operator app creates each node's wallet, but assigns each wallet a **per-node owner / authorization key** (Privy key-quorum). Signing a node's txs then requires that node's owner key — the shared `PRIVY_APP_SECRET` alone cannot move node funds. This makes the operator non-custodial **without** per-node secret infrastructure.
- **Skip task.5081 (OpenBao per-node namespace) for v0.** It is hardening — moving the per-node owner keys into an isolated secret store. The owner-key model already removes the "one app_secret = master key" binding; env-held per-node owner keys are acceptable until a node splits or scales. Graduate to OpenBao then.
- **Net:** operator-not-bound is achievable in v0 via per-wallet owner keys; OpenBao is a later isolation upgrade, not a blocker. (Verify the exact `wallets().create({ owner })` shape against the pinned `@privy-io/node` version when multi-node activation is built.)

## Invariants

- WALLET_CUSTODY: operator never holds a node's keys; wizard txs are founder-signed (spec: node-operator-contract).
- SINGLE_HOME: node wallet/DAO/Split/payments live in `nodes/<x>/.cogni/`, not root (spec: identity-model § Spec File Layering).
- KEY_NEVER_IN_APP / INTENT_ONLY_CALLERS: runtime loop uses typed intents, Privy signs (spec: operator-wallet).
- PER_NODE_SECRET_NAMESPACE: a node's Privy secret is namespaced (OpenBao), never a shared key — the only thing that would otherwise bind the operator (spec: task.5081).
- MONEY_TEST_DEPLOYMENT_PORTABLE: live-money assertions go via HTTP, not direct DB/TB, so the $2 test runs against a deployment.

## Rejected

- **Per-node wizard UI now** — premature; operator-hosted UI is the fastest path and doesn't bind the operator. Package only when a node needs self-serve.
- **A new project** — `proj.node-formation-ui` + `proj.ai-operator-wallet` already own this; refined instead.
- **Shared operator wallet across nodes** — would make the operator custodial; each node owns its own.

## Related

- [proj.node-formation-ui](../../work/projects/proj.node-formation-ui.md) — lifecycle + activation tasks
- [proj.ai-operator-wallet](../../work/projects/proj.ai-operator-wallet.md) — `task.0165` live-money e2e
- [operator-wallet.md](../spec/operator-wallet.md) · [dao-enforcement.md](../spec/dao-enforcement.md) · [node-formation.md](../spec/node-formation.md) · [identity-model.md](../spec/identity-model.md)
