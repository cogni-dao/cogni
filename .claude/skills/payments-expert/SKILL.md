---
name: payments-expert
description: Use whenever working on Cogni USDC credit top-ups, payment intent creation, payment activation, operator wallet funding, 0xSplits allocations, x402 outbound provider payments, Hyperbolic, EIP-3009 signatures, retired OpenRouter/Coinbase top-ups, system-tenant revenue share, repo-spec payment config, live payment rail guards, payment CI failures, or debugging money-loop behavior. Trigger on phrases like payments, payment rail, credits top-up, USDC, Split, 0xSplits, splitHash, x402, Hyperbolic, facilitator, signX402Payment, EIP-3009, OpenRouter funding, Coinbase Commerce, operator wallet, Privy wallet, markup_factor, revenue_share, system bonus, provider top-up, settlement_skipped, SPLIT_CONFIG_MISMATCH, activate payments, node payments, or "is this payment behavior validated". This skill is the launching point for future payments work and debugging.
---

# Payments Expert

Use this as the orientation layer before changing or validating Cogni payment rails. The core failure to avoid is calling a config/startup proof a money-loop proof. Payments are live only when the repo-spec economics, deployed Split, payment-intent guard, settlement path, and observed ledger/provider effects all agree.

## First Rule

Do not claim payment behavior is validated from `/readyz`, startup guards, static config, or unit tests. Those prove boot/config/code paths. Live payment rail validation means:

1. payment-intent creation fails closed when the configured Split is missing or mismatched;
2. payment-intent creation succeeds only after repo-spec points at a matching deployed Split;
3. one real purchase proves user credits, system bonus, provider top-up, DAO margin, and settlement logs.

Candidate/preview may prove the guard and inbound crediting, but may not prove outbound settlement if the operator wallet/provider funding credentials are absent. Watch for `payments.settlement_skipped`.

## Current Foundation

The current inbound economics are repo-spec governed:

| Field                                         |            Default | Meaning                                                                                               |
| --------------------------------------------- | -----------------: | ----------------------------------------------------------------------------------------------------- |
| `payments_in.credits_topup.markup_factor`     | `1.10803324099723` | purchase-side funding multiplier; with the current 5% provider fee, targets about 95% provider top-up |
| `payments_in.credits_topup.revenue_share`     |                `0` | no system-tenant bonus credits minted from user purchases                                             |
| `payments_in.credits_topup.receiving_address` |      Split address | must point at a deployed 0xSplits V2 Split whose `splitHash()` matches repo-spec economics            |

Economic formula:

```text
provider_topup_share = (1 + revenue_share) / (markup_factor * (1 - provider_fee))
```

With provider fee `5%`, `markup_factor = 1 / (0.95 * 0.95) = 1.10803324099723`, and `revenue_share = 0`, the target is about `95%` provider top-up and `5%` DAO Split margin.

The old dangerous state was `markup_factor: 2.0` with `revenue_share: 0`: that implies about `52.63%` provider top-up, not at-cost, and can silently mismatch the deployed Split. Treat stale comments/docs mentioning old `~92.1% / ~7.9%` or `2.0 / 0.75` economics as suspect until reconciled with current code and specs.

## Outbound Direction

As of 2026-06-25, treat the OpenRouter/Coinbase Commerce top-up path as legacy/dead outbound infrastructure. OpenRouter documents that `POST /api/v1/credits/coinbase` has been removed and returns `410 Gone` because Coinbase deprecated the underlying APIs. Source: `https://openrouter.ai/docs/cookbook/administration/crypto-api`.

The current buildable direction from the x402 handoff is narrow:

| Stays unchanged                          | Changes outbound only                                        |
| ---------------------------------------- | ------------------------------------------------------------ |
| inbound user credit purchase             | retire OpenRouter/Coinbase top-up                            |
| credits ledger and human pre-auth budget | add x402 client shim for provider requests                   |
| 0xSplits 95/5 receiving Split            | use Privy named `signX402Payment` for EIP-3009 typed data    |
| Split-hash guard on inbound rail         | route provider cost to Hyperbolic/x402                       |
| repo-spec inbound activation             | add per-request spend-vs-credit guard from LiteLLM cost data |

Important: this is not the old "delete credits, delete Splits, inbound x402 everywhere" direction. Credits remain the human pre-auth layer. Splits remain the inbound revenue rail. The operator wallet's inbound 95% becomes working capital for outbound x402 micro-payments. If `docs/spec/x402-e2e.md` or `work/projects/proj.x402-e2e-migration.md` still says "no credit system, no Privy, no Splits", treat it as stale until the active x402 design PR lands.

Human prerequisite for live x402 proof: a Hyperbolic account, API key, and decision on hosted vs self-hosted x402 facilitator. The signer, shim, LiteLLM wiring, and spend guard can be built and CI-gated without that, but real USDC e2e cannot be proven until the vendor account exists.

## Start By Reading

Read the nearest `AGENTS.md` before editing a directory. Then read only the surfaces relevant to the bug:

| Surface                                        | File                                                                                  |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Current payment activation handoff             | `work/handoffs/task.5083.handoff.md`                                                  |
| Payment setup guide                            | `docs/guides/payments-setup.md`                                                       |
| Operator wallet + Split spec                   | `docs/spec/operator-wallet.md`                                                        |
| Web3/OpenRouter payment spec                   | `docs/spec/web3-openrouter-payments.md`                                               |
| x402 migration project                         | `work/projects/proj.x402-e2e-migration.md`                                            |
| x402 spec, may be stale vs active refined plan | `docs/spec/x402-e2e.md`                                                               |
| Node formation payment invariants              | `docs/spec/node-formation.md`                                                         |
| Root repo-spec payment config                  | `.cogni/repo-spec.yaml`                                                               |
| Operator repo-spec payment config              | `nodes/operator/.cogni/repo-spec.yaml`                                                |
| Repo-spec schema/accessors                     | `packages/repo-spec/src/schema.ts`, `packages/repo-spec/src/accessors.ts`             |
| Split allocation math                          | `packages/operator-wallet/src/domain/split-allocation.ts`                             |
| Operator wallet adapter                        | `packages/operator-wallet/src/adapters/privy/privy-operator-wallet.adapter.ts`        |
| Payment rail guard port                        | `nodes/operator/app/src/ports/payment-rail-guard.port.ts`                             |
| Split guard adapter                            | `nodes/operator/app/src/adapters/server/payments/split-payment-rail-guard.adapter.ts` |
| Payment intent route                           | `nodes/operator/app/src/app/api/v1/payments/intents/route.ts`                         |
| Payment service                                | `nodes/operator/app/src/features/payments/services/paymentService.ts`                 |
| Credit settlement                              | `nodes/operator/app/src/features/payments/services/creditsConfirm.ts`                 |
| Facade config bridge                           | `nodes/operator/app/src/app/_facades/payments/attempts.server.ts`                     |
| Container wiring                               | `nodes/operator/app/src/bootstrap/container.ts`                                       |
| Activation UI                                  | `nodes/operator/app/src/app/(app)/nodes/payments/PaymentActivationPage.client.tsx`    |
| Payment feature rules                          | `nodes/operator/app/src/features/payments/AGENTS.md`                                  |
| Operator-wallet package rules                  | `packages/operator-wallet/AGENTS.md`                                                  |
| Repo-spec package rules                        | `packages/repo-spec/AGENTS.md`                                                        |

Recent refactor to understand: PR `cogni-dao/cogni#1823`, `feat(payments): repo-spec at-cost economics plus Split guard`, head `adc2f8ff5b` in the original workspace. Check GitHub for current merge state before relying on branch-local facts.

Current x402 follow-up to understand: the active plan keeps inbound credits and 0xSplits unchanged, then replaces only the outbound cost hop with x402-to-Hyperbolic. Check the active design/foundation PRs before editing docs that still describe a full credit/Split deletion.

## Architecture Map

The inbound credit top-up flow is:

1. Client calls `POST /api/v1/payments/intents`.
2. Route validates auth/request and delegates to `createPaymentIntentFacade`.
3. Facade resolves billing account, wallet, repo-spec payment config, and `paymentRailGuard`.
4. `createIntent()` calls `paymentRailGuard.assertReady(paymentConfig)` before creating the payment attempt.
5. `SplitPaymentRailGuardAdapter` reads `splitHash()` from the configured Split and compares it to the hash computed from repo-spec economics plus operator wallet plus DAO treasury.
6. Client sends USDC to the returned `to` address.
7. Submit/poll path verifies the on-chain transfer, credits the user, optionally credits system bonus, then runs post-credit funding.
8. Legacy post-credit funding distributes the Split and attempted to top up OpenRouter through the Privy-backed operator wallet when configured.
9. New outbound direction: after credits authorize the spend, the operator pays provider cost per request through an x402 client shim, with Privy signing the EIP-3009 payment authorization via a named `signX402Payment` method.

Layer boundaries matter:

- `packages/repo-spec` is pure schema/accessor code. No env, file I/O, app imports, or chain clients.
- `packages/operator-wallet` owns Split allocation math and Privy HSM transaction submission. No app/database orchestration.
- `src/ports` defines interfaces and port-level errors. No adapter imports.
- `src/features/payments` owns payment state transitions and settlement orchestration. No HTTP/session/database direct access.
- `src/adapters/server/payments` can do EVM RPC reads and implement ports.
- `src/bootstrap/container.ts` wires live/test behavior and optional funding dependencies.

## Debugging Workflow

Start with the failure class, then inspect the matching layer.

| Symptom                                  | First checks                                                                                                                                                                                          |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `503` from `/api/v1/payments/intents`    | response `code`, `PaymentRailNotReadyError`, `PaymentRailMisconfiguredPortError`, repo-spec `receiving_address`, chain ID, operator wallet address, DAO treasury, Split bytecode, Split `splitHash()` |
| `SPLIT_CONFIG_MISMATCH`                  | compute expected allocations from current `markup_factor`, `revenue_share`, provider fee, operator wallet, treasury; compare against deployed Split recipients/allocations                            |
| `PAYMENT_RAIL_UNCONFIGURED`              | repo-spec has `payments_in`, `operator_wallet.address`, `cogni_dao.dao_contract`, runtime has non-test wiring                                                                                         |
| intent succeeds but no OpenRouter top-up | look for `payments.settlement_skipped`; check Privy env, `operator_wallet`, `payments_in`, `EVM_RPC_URL`, `OPENROUTER_API_KEY`, provider funding wiring                                               |
| OpenRouter top-up returns `410 Gone`     | the Coinbase charge API is removed; do not repair around it. Move work to x402 outbound/Hyperbolic unless the user explicitly asks for a legacy fallback                                              |
| x402 outbound cannot be e2e tested       | check for missing Hyperbolic account/API key/facilitator decision; this is a human/vendor prerequisite, not a code proof                                                                              |
| spend-vs-credit uncertainty              | use LiteLLM cost callback/receipt data as the meter; add a per-request guard so outbound USDC spend cannot exceed the user's credit budget/margin policy                                              |
| credits minted incorrectly               | inspect `creditsConfirm.ts`, `revenueShare` source from repo-spec, `platform_revenue_share` ledger entries, idempotency reference `${chainId}:${txHash}`                                              |
| candidate differs from prod              | candidate may lack wallet/provider credentials; prove guard there, but do not call outbound settlement validated without real wallet/top-up evidence                                                  |
| fresh nodes have old economics           | check repo-spec schema defaults, activation UI defaults, node-template and spawned-node copies; use `node-sync-prs` after merged operator changes                                                     |

When debugging live rails, prefer evidence in this order:

1. current deployed SHA/ref (`/version`, workflow evidence, PR head);
2. repo-spec values served by that build;
3. HTTP response from the payment intent endpoint;
4. chain reads of bytecode and `splitHash()`;
5. payment attempt and payment event rows;
6. credit ledger and billing account deltas;
7. operator wallet transaction hashes for Split distribute/legacy provider funding or x402 payment authorization/settlement evidence;
8. provider-side evidence: Hyperbolic/x402 response and USDC settlement, or legacy OpenRouter credit delta only for old branches;
9. Loki events, especially `payments.confirmed`, `payments.funding_complete`, and `payments.settlement_skipped`.

## Activation Checklist

Use this when moving from config correctness to live payments:

- [ ] Confirm the relevant payment PR is merged to `main`; record merge SHA.
- [ ] Flight that SHA to candidate-a and verify `/version` matches.
- [ ] Before updating the Split pointer, call payment intent creation and expect fail-closed `503` with a specific rail code, not transfer params.
- [ ] Deploy a 0xSplits V2 Split whose recipients and allocations match repo-spec economics, operator wallet, and DAO treasury.
- [ ] Update `payments_in.credits_topup.receiving_address` through the normal repo-spec activation/update path.
- [ ] Reflight and verify payment intent creation passes the guard.
- [ ] Promote only after guard proof is clean.
- [ ] Run one small real USDC purchase on prod.
- [ ] Verify: user credits minted, `systemBonusCredits = 0`, provider top-up about `95%`, DAO margin about `5%`, no silent settlement skip.
- [ ] If shared substrate/defaults changed, run `.agents/skills/node-sync-prs/SKILL.md` after merge to sync node-template and relevant spawned nodes.

## Validation Commands

Pick the smallest set that matches the change. Do not use these as a substitute for live payment proof.

```bash
pnpm --filter @cogni/repo-spec build
pnpm --filter @cogni/operator-wallet test
pnpm exec biome check <touched-files>
pnpm vitest run --config nodes/operator/app/vitest.config.mts \
  nodes/operator/app/tests/unit/adapters/server/payments/split-payment-rail-guard.adapter.test.ts \
  nodes/operator/app/tests/unit/features/payments/services/creditsConfirm.spec.ts \
  nodes/operator/app/tests/unit/packages/repo-spec/accessors.test.ts \
  nodes/operator/app/tests/unit/shared/config/repoSpec.server.test.ts
pnpm vitest run tests/unit/packages/repo-spec/accessors.test.ts
gh pr checks <pr> --repo cogni-dao/cogni
```

If a full typecheck fails on unrelated drift, isolate the payment/repo-spec tests and state the residual risk. CI `static` green at the final head is stronger than a stale local package-build failure.

## PR And Review Discipline

For payment PRs, the body should state:

- exact economics (`markup_factor`, `revenue_share`, provider fee assumption, expected provider/DAO split);
- whether a smart contract deployment or repo-spec pointer update is required;
- what fails closed before activation;
- what was validated locally and in CI;
- what has not been behaviorally validated until prod;
- rollback plan if the first real payment proves wrong.

Do not merge or promote money-rail behavior on ambiguous validation language. Say precisely what is proved and what is not.

## Knowledge Updates

When future payment work reveals durable new facts, use [`contribute-knowledge-to-cogni`](../contribute-knowledge-to-cogni/SKILL.md) before writing to the hub. Recall first, refine existing entries when possible, and keep one open contribution branch. As-built contracts belong in `docs/spec/*` shipped with code; atomic findings and operating rules can go to the knowledge hub.

Good candidates for knowledge contribution:

- a newly proven live payment invariant;
- a recurring production failure mode and its diagnostic signature;
- a corrected economic formula or deployment dependency that future agents keep getting wrong;
- a stable validation checklist that outlives the PR.

Bad candidates:

- PR status, transient CI logs, or one-off branch state;
- facts already present in specs or this skill;
- unvalidated claims about live money behavior.
