---
id: node-formation-guide
type: guide
title: Node Formation — DAO Setup Guide
status: draft
trust: draft
summary: Step-by-step guide for forming a new Cogni DAO node via the web wizard.
read_when: Setting up a new DAO node, running the formation wizard, or testing formation locally.
owner: derekg1729
created: 2026-02-07
verified:
tags: [web3, setup, dao]
---

# Node Formation — DAO Setup Guide

> Source: docs/spec/node-formation.md

## When to Use This

You want to create a new Cogni DAO node. The formation wizard walks you through deploying a DAO + GovernanceERC20 token + CogniSignal contract on-chain, then verifying the deployment server-side.

## Preconditions

- [ ] Wallet connected via RainbowKit (configured in `src/shared/web3/wagmi.config.ts`)
- [ ] Connected to a supported chain: Base mainnet (8453) or Sepolia testnet (11155111)
- [ ] Sufficient ETH for gas (2 transactions)
- [ ] Dev server running (`pnpm dev` or `pnpm dev:stack`)

## Steps

### 1. Navigate to the Formation Wizard

Open `/setup/dao` in the application. The wizard page is at `src/app/(app)/setup/dao/page.tsx`.

### 2. Fill in Token Details (3 fields)

| Field           | Example             | Description                                  |
| --------------- | ------------------- | -------------------------------------------- |
| `tokenName`     | "Cogni Governance"  | Human-readable name for the governance token |
| `tokenSymbol`   | "COGNI"             | Short ticker symbol                          |
| `initialHolder` | Your wallet address | Founder address — receives 1e18 tokens       |

### 3. Preflight Validation (Automatic)

The wizard runs preflight checks before enabling deployment:

1. `eth_getCode` for DAOFactory, PluginSetupProcessor, TokenVotingRepo
2. `DAOFactory.pluginSetupProcessor() == PSP` invariant check
3. Chain ID validated against `SUPPORTED_CHAIN_IDS`

If any check fails, the wizard shows an error and blocks deployment.

### 4. Sign Transaction 1: Create DAO

The wizard calls `DAOFactory.createDao()` with TokenVoting plugin and MintSettings. Your wallet signs the transaction. This deploys:

- DAO contract
- GovernanceERC20 token (mints 1e18 to `initialHolder`)
- TokenVoting plugin

### 5. Sign Transaction 2: Deploy CogniSignal

After TX 1 confirms, the wizard deploys `CogniSignal(daoAddress)`. The DAO address is derived client-side from the TX 1 receipt.

### 6. Server Verification (Automatic)

The wizard submits `{ chainId, daoTxHash, signalTxHash, initialHolder }` to the server endpoint (`POST /api/setup/verify`). The server:

1. Derives ALL addresses from transaction receipts (never trusts client)
2. Verifies `balanceOf(initialHolder) == 1e18`
3. Verifies `CogniSignal.DAO() == daoAddress`
4. Returns verified addresses + repo-spec YAML

### 7. Save Repo Spec

The returned `repoSpecYaml` should be saved to `.cogni/repo-spec.yaml` in your repository.

### 8. Deploy Infrastructure (Post-Formation)

After on-chain formation, the new node needs infrastructure to run. These steps are **not automated yet** — each is a manual TODO:

- [ ] **Scaffold node code from `nodes/node-template/`**: copy to `nodes/{node}/`, update package names + ports + drizzle config.
- [ ] **Set up the node's DB schema layer.** Cogni nodes share the **core schema** (`@cogni/db-schema` — auth, billing, ledger, identity) and extend it with a **node-local schema** (`@cogni/{node}-db-schema`) for tables only that node owns. The new node has its own database, drizzle config, and migration history — independent of other nodes.
  1. Create `nodes/{node}/packages/db-schema/` for node-local tables; point `nodes/{node}/drizzle.config.ts` at it.
  2. Add `db:generate:{node}`, `db:migrate:{node}`, `db:check:{node}` in `package.json`, mirroring an existing node.
  3. Extend the `pnpm db:check` umbrella so the new chain is gated by pre-commit + pre-push.

  Why the gate matters: drizzle-kit can't model RLS policies, triggers, or other Postgres-specific DDL, so those migrations get hand-authored. The matching snapshot has to be hand-authored too, or `db:generate:{node}` silently rots for the next contributor. `pnpm db:check` catches this. See [databases.md §2.6](../spec/databases.md).

- [ ] **Add node overlay on the app branch**: Create `infra/k8s/overlays/{env}/{node}/kustomization.yaml` on `main` (via PR). `promote-and-deploy.yml` rsyncs `infra/k8s/` from main to each `deploy/*` branch except `env-state.yaml`, so overlays propagate automatically. Copy an existing node's overlay and update `namePrefix`, `NodePort`, secret refs, and the kustomize `replacements:` block. Do NOT hand-edit overlays on deploy branches — invariant `INFRA_K8S_MAIN_DERIVED` (bug.0334) requires they track main. Seed `env-state.yaml` via `provision-test-vm.sh`.
- [ ] **Add catalog entry**: Create `infra/catalog/{node}.yaml` on the app branch. Argo ApplicationSets discover nodes via catalog files — without this, Argo won't create an Application for the new node.
- [ ] **Create k8s secrets**: `{node}-node-app-secrets` in each target namespace. `deploy-infra.sh` creates these from GitHub environment secrets, but a new node needs its own DB and credentials.
- [ ] **Create node database**: Add the node's DB name to `COGNI_NODE_DBS` and run `db-provision`.
- [ ] **Update Caddy routing**: Add subdomain → NodePort mapping in `infra/compose/edge/configs/Caddyfile.tmpl`.
- [ ] **Update DNS**: Add A record for `{node}-{domain}` → VM IP.

See [Multi-Node Deploy Guide](./multi-node-deploy.md) for the full deployment workflow.

## Verification

After formation completes successfully:

1. Check that `.cogni/repo-spec.yaml` contains `dao_contract`, `plugin_contract`, `signal_contract`, and `chain_id` (as string)
2. Verify the DAO exists on the Aragon app for your chain
3. Confirm token balance: `balanceOf(initialHolder)` should return `1000000000000000000` (1e18)

## Troubleshooting

### Problem: Preflight fails with "Contract not found"

**Solution:** Ensure you're connected to a supported chain (Base mainnet or Sepolia). The Aragon OSx contracts are only deployed on these chains.

### Problem: Transaction reverts during createDao

**Solution:** Check that you have sufficient ETH for gas. The `createDao` call deploys multiple contracts and requires more gas than a simple transfer.

### Problem: Server verification returns error

**Solution:** The server uses strict receipt decoders — missing events cause errors. Ensure both transactions confirmed successfully on-chain before the verify call.

## Known Limitation — Payment Activation Is Per-(Node × Env)

Formation (above) is a one-time on-chain act. **Payment _activation_ — the operator wallet (Privy custody) + Split contract + OpenRouter top-up config — is a separate step that must be repeated for every `(node × environment)`.** A node's `candidate`, `preview`, and `production` deployments each need their own wallet / Split / credentials, because a test environment must not hold production custody keys.

Today only **production** is typically activated. Consequence (`bug.5087`): in `candidate`/`preview`, the operator wallet is `undefined` (`nodes/operator/app/src/bootstrap/container.ts` requires `PRIVY_APP_*` + `operator_wallet` + `payments_in` + `EVM_RPC_URL`), so the **outbound** half of a payment — Split distribute + OpenRouter top-up — **silently skips**. Inbound (USDC received → credits minted) still works; the received USDC stays in the Split and OpenRouter is never funded. The skip now emits `payments.settlement_skipped` so it is observable.

**Implication for testing:** the full payment loop **cannot be validated end-to-end on candidate-a** as configured — there is no wallet there to perform the outbound. Validating the money loop requires either (a) a per-env test payment stack (test Privy app + test Split + test OpenRouter key), or (b) validation on production.

**Status: deferred.** Aligning payment activation with the per-env deploy path (env-aware, driven from the node-spec + wizard) is future work; for now, the outbound is validated on production. See `bug.5087`.

## Related

- [Node Formation Spec](../spec/node-formation.md)
- [Node Formation Project](../../work/projects/proj.node-formation-ui.md)
- [Node vs Operator Contract](../spec/node-operator-contract.md)
- [Cred Licensing Policy](../spec/cred-licensing-policy.md)
