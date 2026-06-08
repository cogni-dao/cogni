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
verified: 2026-06-08
tags: [web3, setup, dao]
---

# Node Formation — DAO Setup Guide

> Source: docs/spec/node-formation.md

## When to Use This

You want to create a new Cogni DAO node. The formation wizard walks you through deploying a DAO + GovernanceERC20 token + CogniSignal contract on-chain, then verifying the deployment server-side.

## Where This Fits

This guide covers the **monorepo node** path — a node born into the Cogni monorepo, riding shared CI/CD. Want your **own standalone instance** instead? That's a different axis (substrate provisioning, not DAO formation) — follow [`fork-quickstart.md`](../runbooks/fork-quickstart.md) (`Cogni-DAO/standalone-node`). The architecture and the two-repo split live in the [Node Formation Spec](../spec/node-formation.md) § The Blessed Path.

The arc this guide drives:

```
1. Register    wizard at /nodes → DB-backed node row (Step 1)
       ↓
2. Formation   per-node wizard page → DAO + token + CogniSignal on-chain, server-verified (Steps 2-7)
       ↓
3. Publish     operator mints the node repo and authors ONE submodule deployment PR (Step 8)
       ↓
4. Flight      POST /api/v1/vcs/flight {nodeRef:{nodeId,sourceSha}} → digest lands at <node>-test.cognidao.org
       ↓
5. Ongoing     per-node deploy branch + Argo Application; subsequent merges auto-deploy (CATALOG_IS_SSOT)
```

Registration makes the operator DB-aware before any wallet transaction. Formation (Steps 2-7) is **node-owned tooling** — wallet signs in the browser, server verifies and persists the verified addresses to the node row. Publish + Flight (Step 8 onward) are operator-driven.

## Preconditions

- [ ] Wallet connected via RainbowKit (configured in `src/shared/web3/wagmi.config.ts`)
- [ ] Connected to a supported chain: Base mainnet (8453) or Sepolia testnet (11155111)
- [ ] Sufficient ETH for gas (2 transactions)
- [ ] Dev server running (`pnpm dev` or `pnpm dev:stack`)

## Steps

### 1. Register a Node

Open `/nodes` in the application, choose a slug, and create the node row. The canonical per-node wizard page is `src/app/(app)/nodes/[id]/page.tsx`.

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
4. Returns verified addresses

### 7. Persist Verified Addresses

The per-node wizard patches the `nodes` registry row with the verified DAO, plugin, token, and CogniSignal addresses. This is the DB-aware boundary before the operator mints the repo or opens a deployment PR.

### 8. Publish — Operator Authors the Node PR (Automated)

> **This is no longer a manual checklist.** The operator authors the node's entire monorepo footprint as a **single GitHub App–authored PR** (the **Publish** phase, `task.5092`) directly via the GitHub Git Data API — no GitHub Action, no human PAT, no hand-copied files. See [Node Formation Spec § Node Publish](../spec/node-formation.md#node-publish-operator-authored-pr) for the mechanism.

What the Publish PR contains:

- **Submodule gitlink** — `nodes/<slug>` is a `160000` gitlink pointing at the node's own minted repo (`Cogni-DAO/<slug>`, `generate`d from the `node-template` template), plus a `.gitmodules` stanza. The node's ~1100 files live in _that_ repo, not inlined here; identity (`node_id` / `scope_id` + DAO addresses in `.cogni/repo-spec.yaml`) is set in the node repo before the pin.
- **Catalog entry** — `infra/catalog/<slug>.yaml`. This is the keystone: `CATALOG_IS_SSOT` ([ci-cd.md](../spec/ci-cd.md) Axiom 16) means overlays, AppSets, Caddy routing, scheduler endpoints, and the build matrix all derive from it. (The submodule _pin_ lives in `.gitmodules` — git-native — not the catalog.)
- **Generated footprint** (byte-exact, drift-gated against `scripts/ci/render-*.sh`): overlays ×3 (`infra/k8s/overlays/{candidate-a,preview,production}/<slug>/`), per-node AppSets ×3 (`infra/k8s/argocd/<env>-<slug>-applicationset.yaml`, Axiom 18), Caddyfile route, `ci.yaml` scope filter, scheduler-worker endpoints. **No `pnpm-lock.yaml`** — a submodule node is not a workspace member of the operator monorepo.
- **ESO-first all-env shape** — the minted child repo carries `k8s/external-secrets/{candidate-a,preview,production}/{external-secret.yaml,kustomization.yaml}`; when pinned at `nodes/<slug>`, the substrate lane applies each leaf as `nodes/<slug>/k8s/external-secrets/<env>/` and materializes `<slug>-env-secrets`.

**Secret values are NOT in the PR.** The per-node `secrets-catalog.yaml` is absent from the template seed; a node inherits the shared secret baseline via OpenBao/ESO, so no secret value ever lands in git. ExternalSecret shape is present because each generated Deployment consumes `<slug>-env-secrets`. To add a node-specific secret later, edit `nodes/<slug>/.cogni/secrets-catalog.yaml` (one PR, node domain) — see the [cicd-secrets-expert skill](../../.claude/skills/cicd-secrets-expert/SKILL.md).

**Your job after Publish:**

1. **Review + merge** the operator PR (CI green). Note: the node's source-code PRs happen in the child repo; the parent birth PR is operator control-plane work: gitlink/pin acceptance plus catalog/overlays/AppSets/Caddy/scheduler wiring.
2. **Flight**: `POST /api/v1/vcs/flight { nodeRef: { nodeId, sourceSha } }` → the operator resolves `image_repository:sha-<sourceSha>` to a digest and deploys it at `https://<slug>-test.cognidao.org`. The parent PR number is review metadata for the operator pin PR, not the deploy coordinate. For creator/admin approval of an AI developer before flight, follow [Browser-Session Flight Auth](./browser-session-flight-auth.md).
3. **Validate**: run [`/validate-candidate`](../../.claude/skills/validate-candidate/SKILL.md) against the deployed build.

Per-node DNS, DB, and secrets reconcile **inside the flight/promote lane** (idempotent, catalog-driven — `DNS_IS_RECONCILED_PER_ENV`, Axiom 21), not via a full env reprovision. For the row-by-row deploy contract (nodePort allocation, overlay/AppSet proof, DB schema layer, the candidate-a-only trap) see [Create a New Node (Deploy)](./create-node.md).

## Verification

After formation completes successfully:

1. Check that the node row has `dao_address`, `plugin_address`, `signal_address`, `token_address`, `dao_tx_hash`, and `signal_tx_hash`
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

- [Node Formation Spec](../spec/node-formation.md) — formation + Publish + payment-activation design
- [Create a New Node (Deploy)](./create-node.md) — the deploy-row contract Step 8 hands off to
- [Browser-Session Flight Auth](./browser-session-flight-auth.md) — creator/admin approval before bearer-token nodeRef flights
- [Fork Quickstart](../runbooks/fork-quickstart.md) — the standalone-fork alternative (`Cogni-DAO/standalone-node`)
- [cicd-secrets-expert skill](../../.claude/skills/cicd-secrets-expert/SKILL.md) — why secrets are stripped from the Publish PR (ESO-inherited)
- [Node Formation Project](../../work/projects/proj.node-formation-ui.md)
- [Node vs Operator Contract](../spec/node-operator-contract.md)
- [Cred Licensing Policy](../spec/cred-licensing-policy.md)
