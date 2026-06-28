---
id: research.per-node-ai-funding
type: research
title: Per-Node AI-Provider Funding for Spawned + Externally-Governed Nodes
status: draft
trust: draft
summary: How an externally-governed node funds its OWN AI inference in USDC with no card, without drawing on Derek's shared OpenRouter account. Recommends a hybrid — per-node Hyperbolic balance funded by the node's own non-custodial wallet (sovereign default) + a shared, capped OpenRouter org as a proprietary-model bridge — and shows why the "fund the right OpenRouter account" binding mostly dissolves rather than gets solved.
read_when: Designing per-node provider funding, node activation outbound, or evaluating OpenRouter org/sub-account multi-tenancy.
owner: derekg1729
created: 2026-06-25
tags:
  [
    payments,
    x402,
    openrouter,
    hyperbolic,
    provider-funding,
    sovereignty,
    node-formation,
  ]
---

# Per-Node AI-Provider Funding

> SPIKE — research only, no production code. Reconciles the spike brief (steward-wallet → OpenRouter top-up) against the live as-built direction, then recommends a topology + binding model + 3-step migration.

## TL;DR

1. **The spike's premise is built on a dead path.** OpenRouter's programmatic crypto top-up (`POST /api/v1/credits/coinbase`) is **removed → 410 Gone** (Coinbase deprecated the underlying APIs). OpenRouter crypto funding is now a **manual web checkout** (routed through Coinbase Business Checkout); there is **no programmatic USDC-on-Base top-up API**. So "the steward wallet funds the right OpenRouter account" cannot be automated at all — and the repo already pivoted away from it (`x402-usdc-egress` hub finding, bug.5063).
2. **The binding problem mostly dissolves, it isn't solved.** Both live directions remove the shared off-chain account you'd otherwise have to bind a wallet to:
   - `node-payments-empowerment.md` already gives each node its **own non-custodial wallet** (P-256 owner-key quorum; node A's key cannot move node B's wallet).
   - `x402-usdc-egress` / `hyperbolic-provider-setup` already say each node runs its **own Hyperbolic account**, funded by **bulk USDC top-up** from its own wallet, with **per-env `HYPERBOLIC_API_KEY`** in the node's own ESO/OpenBao namespace.
     Put together: a node funds its own provider from its own wallet. There is no shared account, so "node A funds node B's account" is structurally impossible — the isolation is the per-node wallet + per-node secret, not a mapping table we must police.
3. **Recommended topology = (d) hybrid, but lopsided:**
   - **Sovereign default — OSS models → Hyperbolic.** Per-node Hyperbolic account; node's own wallet bulk-tops-up its balance at a drawdown threshold (Tier-1 of `x402-usdc-egress`). LiteLLM unchanged (API key). No per-request signing.
   - **Bridge only — proprietary models (Claude/GPT/Gemini) → OpenRouter.** ONE shared OpenRouter org, per-node **provisioning keys** with per-key `limit`, metered + capped by **LiteLLM virtual-key budgets**, charged back against each node's credits. Funded by Derek's Coinbase Business balance as an explicit, exitable subsidy — NOT sovereign.
4. **If we do nothing:** every externally-governed node's AI is billed to Derek's single shared `OPENROUTER_API_KEY`. Not sovereign, not metered per node, and uncapped — one node can drain the shared account for everyone (the AI-outage 402 class of failure, masked as `internal`).

## 1. Topology options (N nodes)

| #   | Topology                                                                                | Crypto-fundable per node?                                              | Per-node isolation                                         | Proprietary models? | Verdict                                                                                      |
| --- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------- |
| a   | **Each node its OWN OpenRouter account**, its steward funds it directly                 | ❌ signup is human web; funding is human web checkout (410 on the API) | account-level                                              | ✅                  | **Dead** — cannot automate signup or USDC funding; violates OSS-sovereign/no-card            |
| b   | **One shared OpenRouter org**, per-node provisioning keys + per-key `limit`, chargeback | ❌ org funded by ONE pooled fiat/Coinbase-Business balance (Derek's)   | per-key budget cap                                         | ✅                  | **Bridge** — only programmatic multi-tenant control OpenRouter offers; not sovereign         |
| c   | Shared pool funded by aggregated per-node revenue, metered per node                     | ❌ accounting overlay on (b); dollars still Derek's                    | per-key metering                                           | ✅                  | Same sovereignty gap as (b) + revenue-routing complexity                                     |
| d   | **Hybrid: Hyperbolic per-node (sovereign) + shared OpenRouter (capped bridge)**         | ✅ for Hyperbolic (USDC top-up / x402); ❌ for the OpenRouter bridge   | per-node wallet+key (Hyperbolic); per-key cap (OpenRouter) | ✅ via bridge       | **RECOMMENDED** — sovereign for the OSS majority, pragmatic bridge for proprietary, exitable |

**Why (d), not (a):** (a) is the intuitive "each node owns its OpenRouter" answer and it is a hard dead end — OpenRouter org/account creation is **web-only** (no API), and crypto funding is **web-only** (no API; old endpoint 410). You cannot have a node self-provision and self-fund an OpenRouter account. Hyperbolic is the only provider that accepts **USDC on Base** for account balance (and even account-free per-request x402), so the sovereign path runs through Hyperbolic, with OpenRouter demoted to a capped bridge for the models Hyperbolic can't serve.

## 2. Provider mechanics (verified 2026-06-25)

**OpenRouter**

- Crypto top-up API **removed → 410 Gone**; funding is manual web / Coinbase Business Checkout; **no programmatic USDC-on-Base top-up**. (`openrouter.ai/docs/use-cases/crypto-api`)
- **Provisioning (management) keys: YES** — `/api/v1/keys` create/list/patch/delete; mgmt keys can't call completions. (`/docs/features/provisioning-api-keys`)
- **Per-key budget: YES** — `limit` field per key (+ `limit_remaining`, optional daily/weekly/monthly resets). One account → many funded, individually-capped keys.
- **Workspaces / Organizations: YES** for isolation + shared credit pool — but **created via web UI only; no API to create an org/account**; personal→org credit transfer needs manual support processing. (`/docs/cookbook/administration/organization-management`)

**Hyperbolic** (`hyperbolic-provider-setup` hub guide)

- **Account balance funded with USDC/USDT/DAI on Base** + auto-refuel-when-low (`app.hyperbolic.ai/billing`) — **manual dashboard** flow (no documented programmatic funding API yet — the one human-provisioning prereq).
- **Per-request x402 USDC: YES** (`hyperbolic-x402.vercel.app`, account-free) — but that's the **Tier-3 anti-pattern** as a transport (1 sign + 1 settle every call; a 50-step graph = 50 settlements). Avoid.
- **OSS models only** (DeepSeek-V3, Llama-3.3-70B, Qwen3-235B, Kimi-K2…). No Claude/GPT/Gemini; no embeddings endpoint.
- Native LiteLLM `hyperbolic/` prefix → LiteLLM config is a provider swap, not a rewrite.

**LiteLLM** (the meter — already in path)

- Virtual keys with **`max_budget` + `budget_duration`** per key; spend auto-tracked; read via `/key/info` (`spend`), `/spend/logs`, `/global/spend/report`. → per-node spend cap + top-up sizing without new infra. (`docs.litellm.ai/docs/proxy/virtual_keys`, `/cost_tracking`)

**Coinbase**

- Self-custodial **Commerce is shutting down** (merchant cutoff ~2026-03-31 outside US/SG); successor **Coinbase Business** (custodial) does USDC-on-Base payment links/invoices — **but availability is US/Singapore-gated today**. Funding the OpenRouter bridge this way is geo-constrained.

## 3. The binding (the sharpest question)

> "How do WE ensure the admin/steward wallet has the correct permissions to fund the right OpenRouter account, and stop node A's steward from funding node B's account?"

**Answer: don't bind a wallet to a shared off-chain provider account — there is no shared account in the recommended design.** The identity chain per surface:

**Sovereign surface (Hyperbolic, the default):**

```
node N repo-spec / secrets (node's own repo, node's own ESO namespace)
  ├─ node_wallet.address           (on-chain, owned by N's P-256 quorum)
  ├─ PRIVY_SIGNING_KEY = N's P-256 owner private key   ← only thing that can SPEND N's wallet
  └─ HYPERBOLIC_API_KEY (per-env)  ← only thing that can BILL N's Hyperbolic balance
N's container: bulk USDC top-up (N's wallet → N's Hyperbolic balance) at drawdown threshold
```

- **Who writes the mapping?** No mapping. Both the spend authority (P-256 owner key, per `node-payments-empowerment`) and the provider credential (`HYPERBOLIC_API_KEY`) live as **per-node, per-env secrets in N's own OpenBao/ESO namespace**, delivered via the self-serve secrets API (`secrets_manager` / `can_manage_secrets` RBAC).
- **Why can't N's steward fund M's provider?** N's container only holds N's owner key and N's Hyperbolic key. It has no credential for M's wallet (different P-256 quorum) and no credential for M's Hyperbolic account (different per-node secret). Isolation is **by construction**, not by an access-control rule we have to author and audit.
- Composes with the credential-broker direction (BYO-AI): the owner key becomes a tenant-scoped `connection` (AEAD, `privy_authorization_key`) resolved at invocation under grant-intersection — strictly stronger than env-held keys (`node-payments-empowerment` §4).

**Bridge surface (shared OpenRouter, proprietary only):**

- The binding lives **operator-side**: `node_id → {OpenRouter provisioning-key id, LiteLLM virtual-key, per-key limit}`, authored when the operator mints the per-node key, gated by operator RBAC. The **node's wallet never touches OpenRouter funding** — Derek's org funds it. Per-node isolation = the per-key `limit` + LiteLLM `max_budget`, chargeback debited against the node's credits. A node can't overspend its cap; it also can't fund the org (intentional — it's a subsidy, not sovereignty).

## 4. Metering / spend cap

LiteLLM already meters cost per request (it's the oracle for `charge_receipts`). Use it directly:

- **Top-up sizing:** read accumulated per-key spend (`/key/info` → `spend`) to trigger the Hyperbolic bulk top-up at a drawdown threshold (Tier-1).
- **Per-node cap:** set `max_budget` + `budget_duration` on each node's LiteLLM virtual key so a node cannot outspend its credits/steward balance — closes the "one node drains the shared account" failure (the AI-outage 402 class).

## 5. Pareto migration: shared Derek OpenRouter → each node funds its own AI

Smallest coherent steps, each independently shippable, none a dead end:

1. **Cap the blast radius now (days).** Put **LiteLLM virtual keys per node** in front of the existing shared `OPENROUTER_API_KEY`, with `max_budget` + spend read. No new accounts, no crypto. Immediately stops one node draining the shared key and gives per-node spend visibility. _(Pure metering layer; reversible.)_
2. **Sovereign OSS lane (Hyperbolic) for the default path (weeks).** Add a per-node Hyperbolic account + per-env `HYPERBOLIC_API_KEY` (human funds initial balance, `hyperbolic-provider-setup`); LiteLLM routes OSS models to `hyperbolic/`. Then wire the **bulk USDC top-up** from the node's own wallet (the `node-payments-empowerment` P-256 primitive) at a LiteLLM-driven drawdown threshold — replacing `fundOpenRouterTopUp` → `fundHyperbolicTopUp`. Now OSS inference is per-node, crypto-funded, sovereign.
3. **Demote OpenRouter to a capped proprietary bridge (as needed).** Keep ONE shared OpenRouter org for Claude/GPT/Gemini + embeddings only, fan out per-node provisioning keys with per-key `limit`, charge back against node credits, fund via Coinbase Business. Document it as an explicit non-sovereign subsidy with a clean exit (every node already has a wallet; when an OSS-equivalent suffices, drop the bridge).

**What breaks if we do nothing:** every externally-governed node's AI is billed to Derek's single shared `OPENROUTER_API_KEY` — uncapped (one node can exhaust it for all, masked as `internal` per the AI-outage finding), unmetered per node, and fiat-funded by Derek. Neither sovereign nor scalable.

## Open questions

- Hyperbolic **programmatic bulk top-up API** vs dashboard/auto-refuel — the one unverified human-provisioning prereq for fully automating step 2 (`x402-usdc-egress`).
- Embeddings have **no Hyperbolic endpoint** — must stay on OpenRouter/OpenAI/self-hosted; keeps a thin proprietary-bridge dependency even in the all-OSS case.
- Coinbase Business **geo-gating** (US/SG) may block the OpenRouter-bridge funding path for non-US nodes — another reason to minimize the bridge.

## Related

- `docs/design/node-payments-empowerment.md` — per-node non-custodial wallet (P-256 owner key); the spend-authority half of the binding.
- `docs/spec/x402-e2e.md` + `work/projects/proj.x402-e2e-migration.md` — full x402/Hyperbolic migration (note: "delete credits/Splits/Privy" framing is the AGGRESSIVE variant; `payments-expert` + `x402-usdc-egress` refine it to "keep inbound credits + Splits, replace only outbound").
- Hub: `payments-billing-rail`, `x402-usdc-egress` (bug.5063), `hyperbolic-provider-setup` — the as-built + provider-setup truth.
  </content>
  </invoke>
