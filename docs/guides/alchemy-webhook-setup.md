---
id: alchemy-webhook-setup-guide
type: guide
title: Alchemy Webhook Setup
status: draft
trust: draft
summary: Configure Alchemy webhooks for on-chain governance signal execution.
read_when: Setting up on-chain DAO signal execution for local dev or production.
owner: derekg1729
created: 2026-03-11
verified: 2026-03-11
tags: [dev, governance, alchemy, webhooks]
---

# Alchemy Webhook Setup

Alchemy monitors a CogniSignal contract for `CogniAction` events. When a DAO proposal executes a signal, Alchemy sends a webhook to this app. The app re-verifies the transaction on-chain and executes the GitHub action (merge PR, grant/revoke collaborator).

## Setup

1. [Alchemy Dashboard](https://dashboard.alchemy.com) → **Data** → **Webhooks** → **+ Create webhook**
2. Type: **Custom**
3. Chain: match `governance.chain_id` in your repo-spec (e.g. Base = 8453)
4. GraphQL query — paste this, replacing `SIGNAL_CONTRACT` with your `governance.signal_contract` address:
   ```graphql
   {
     block {
       logs(
         filter: {
           addresses: ["SIGNAL_CONTRACT"]
           topics: [
             "0xfd9a8ea95d56c7bd709823c6589c50386a2e5833892ef0e93c7bf63fee30bde1"
           ]
         }
       ) {
         data
         topics
         account {
           address
         }
         transaction {
           hash
           nonce
           index
           from {
             address
           }
           to {
             address
           }
           value
           gasPrice
           status
           gasUsed
         }
       }
     }
   }
   ```
   The topic hash is the `CogniAction` event signature (`keccak256` of the event ABI). See [cogni-signal-evm-contracts](https://github.com/Cogni-DAO/cogni-signal-evm-contracts) `COGNI-GIT-ADMIN-INTEGRATION.md` for details.
5. Webhook URL: a [smee.io](https://smee.io) channel for local dev (see below), or `https://<your-domain>/api/internal/webhooks/alchemy` for production
6. Add to `.env.local`:
   ```bash
   ALCHEMY_WEBHOOK_SECRET=<"Auth token" from the Webhooks page>
   EVM_RPC_URL=<from Alchemy Dashboard → Endpoints, same chain>
   ```

Contract addresses (`signal_contract`, `dao_contract`, `chain_id`) come from `.cogni/repo-spec.yaml` or `.cogni/repo-spec.dev.yaml`.

---

## Local Development

Alchemy can't reach localhost. Use [smee.io](https://smee.io) as a proxy:

1. https://smee.io/new → copy the URL
2. Use that smee URL as your webhook URL in Alchemy (step 5 above)
3. Add to `.env.local`: `ALCHEMY_PROXY_URL=https://smee.io/<your-channel>`
4. Run: `pnpm dev:smee:alchemy`

Use `.cogni/repo-spec.dev.yaml` (gitignored) for local DAO config. See [Developer Setup](./developer-setup.md#on-chain-governance-optional).

### Verification

Trigger a CogniAction event. App logs should show:

```
signal dispatch: processing tx <hash>
signal execution complete: { action: "merge", target: "change", success: true }
```

Rejection reasons: `chain_id mismatch`, `dao_contract mismatch`, `tx already executed`.

### Reference

- [cogni-signal-evm-contracts](https://github.com/Cogni-DAO/cogni-signal-evm-contracts) — contract ABI, deployment, `CogniAction` event spec
- [cogni-git-admin](https://github.com/Cogni-DAO/cogni-git-admin) — original webhook handler implementation
  - `src/providers/onchain/alchemy.ts` — adapter (parses `event.data.block.logs[].transaction.hash`)
  - `test/fixtures/alchemy/CogniSignal/` — real captured Alchemy payloads
