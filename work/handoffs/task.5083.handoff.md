---
id: task.5083.handoff
type: handoff
work_item_id: task.5083
status: active
created: 2026-06-24
updated: 2026-06-24
branch: derekg1729/payments-pricing-repospec-seam
last_commit: adc2f8ff5b
pr: 1823
---

# Handoff: Payment activation after repo-spec economics guard

## Mission

Pickup: take over the payment activation path after PR #1823. Own the post-merge work that turns repo-spec at-cost economics into a live, guarded payment rail: deploy the matching Split, update the repo-spec receiving address, prove the guard fails closed before activation and passes after activation, then validate one real prod payment.

## Goal

- All nodes, including fresh node spawns, default to repo-spec-defined payment economics: `markup_factor: 1.10803324099723` and `revenue_share: 0`.
- Live payment intent creation must be guarded against Split/config mismatch. A wrong, missing, unreadable, or wrong-chain Split returns 503 before transfer params are shown.
- Activation deploys a 95/5 Split and writes the resulting Split address into `payments_in.credits_topup.receiving_address`.
- E2E validation signal: candidate-a serves the merged SHA/ref, `/api/v1/payments/intents` returns 503 `SPLIT_CONFIG_MISMATCH` before the repo-spec pointer matches the live Split, then succeeds after activation updates the pointer. Prod proof requires one small real USDC purchase showing system bonus `0`, provider top-up about `95%`, and DAO margin about `5%`.

## Start By Reading

- PR #1823: https://github.com/cogni-dao/cogni/pull/1823
- `docs/guides/payments-setup.md`
- `docs/guides/operator-wallet-setup.md`
- `docs/guides/node-formation-guide.md`
- `docs/spec/node-formation.md`
- `docs/spec/operator-wallet.md`
- `docs/spec/web3-openrouter-payments.md`
- `.cogni/repo-spec.yaml`
- `nodes/operator/.cogni/repo-spec.yaml`
- `nodes/operator/app/src/ports/payment-rail-guard.port.ts`
- `nodes/operator/app/src/adapters/server/payments/split-payment-rail-guard.adapter.ts`
- `nodes/operator/app/src/app/(app)/nodes/payments/PaymentActivationPage.client.tsx`
- `nodes/operator/app/src/features/payments/services/paymentService.ts`
- `.agents/skills/node-sync-prs/SKILL.md`

## Current State

- #1823 is open, mergeable, and merge queued per Derek. Head SHA: `adc2f8ff5b09fef024523590f796b47b479bab63`.
- #1823 CI is green at that head: PR review, title, static, unit, component, single-node-scope, and sonar-disabled passed; PR Build jobs are skipped as expected.
- #1823 PR body is accurate. It states the activation requirement and the prod payment validation requirement.
- The old bad economics were corrected. `markup_factor: 2.0` plus `revenue_share: 0` would have implied about 52.63% provider top-up and a silent mismatch. The new default is `1 / (0.95 * 0.95) = 1.10803324099723`, targeting 95% provider top-up with the current 5% provider fee.
- #1823 does not deploy the new Split and does not make payments live by itself. It makes the config and live guard correct, then fails closed until activation updates the Split pointer.
- Existing candidate/preview payment testing may still be limited by `bug.5087`: no fully funded operator wallet/outbound settlement path. Do not claim payment behavior is fully validated from startup or `/readyz` proof.
- The repo no longer has `work/items/`; canonical work item state lives in prod Doltgres, so this handoff link was not appended to a local work item file.

## Design / Implementation Target

1. Keep repo-spec as the source of truth for `payments_in.credits_topup.markup_factor`, `revenue_share`, `receiving_address`, and chain/provider fields.
2. Keep payment intent creation fail-closed: no transfer params when the configured Split cannot be read or does not match repo-spec economics plus operator wallet plus DAO treasury.
3. Activation must deploy a 0xSplits V2 Split whose allocations match repo-spec economics: provider/operator side about 95%, DAO treasury about 5%, distribution incentive 0.
4. Activation must update both relevant repo-spec paths through the normal PR/activation flow, especially `payments_in.credits_topup.receiving_address`.
5. Fresh node spawn defaults must receive the same economics, not an env-only override.
6. Do not use startup health as money-rail proof. The proof is live payment-intent guard behavior plus one real prod payment after activation.
7. After #1823 merges, propagate the merged standard to `Cogni-DAO/node-template` and active spawned node repos that carry copied repo-spec/package/payment activation code.

## Next Actions / Risks

- [ ] Confirm #1823 has merged to `main`; record the merge SHA.
- [ ] Flight the merged SHA to candidate-a and verify candidate `/version` reports the expected SHA/ref.
- [ ] Exercise payment intent creation before Split activation; expect 503 `SPLIT_CONFIG_MISMATCH` or a specific fail-closed payment-rail code, not transfer params.
- [ ] Use `/nodes/payments` or the equivalent activation path to deploy the 95/5 Split on Base using the operator wallet and DAO treasury.
- [ ] Update `.cogni/repo-spec.yaml` and `nodes/operator/.cogni/repo-spec.yaml` to point `payments_in.credits_topup.receiving_address` at the new Split address.
- [ ] Reflight and recheck payment intent creation; a matching Split should pass the guard.
- [ ] Promote only after the guard proof is clean, then run one small real USDC prod purchase and verify logs/ledger/top-up economics.
- [ ] Use the `node-sync-prs` skill to port the merged standard to node-template first, then relevant spawned nodes.
- [ ] Open a docs follow-up for stale old-economics text in `docs/spec/operator-wallet.md`, `docs/spec/web3-openrouter-payments.md`, and `work/projects/proj.ai-operator-wallet.md`.
- Risk: candidate may prove the guard but still not fully prove outbound settlement if wallet/funding credentials are absent. Prod real-payment validation is the final money-loop proof.
