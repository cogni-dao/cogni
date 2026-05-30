---
id: task.5083.handoff
type: handoff
work_item_id: task.5083
status: active
created: 2026-05-30
updated: 2026-05-30
branch: derekg1729/operator-node-registry-v0
last_commit: 1205e59bd
---

# Handoff: Operator node-registry v0 — wizard is GOVERNANCE-ONLY (spec realignment)

## Context

- Goal: operator setup wizard that takes a founder from "I want a node" → a Cogni node, no CLI / no manual YAML paste. Work item `task.5083`, PR **#1381**, branch `derekg1729/operator-node-registry-v0`.
- v0 is **monorepo-internal**: a node = a new `nodes/<slug>/` dir in `Cogni-DAO/cogni`. Postgres `nodes` row = live wizard state; `.cogni/repo-spec.yaml` = git manifestation on publish.
- **A design review (read it: `docs/research/` is NOT where it lives — it's pasted into this work item's history / ask Derek) found the wizard violates two named `docs/spec/node-formation.md` invariants.** That review is the reason this handoff exists. The fix is an architecture realignment, mostly **deletion**.

## Current State

- ✅ DAO formation works E2E on candidate-a (block-not-ready retry fixed; status bar, slug form, Base-only, users-upsert all shipped). CI 14/14 green on `d8a1284e`; flighted.
- 🔴 **BLOCKED + ARCHITECTURALLY WRONG: the "Provision operator wallet" step.** It 503s, but the real problem is it should not exist. `provision-wallet/route.ts` uses the **shared operator's** `PRIVY_APP_ID` to mint a child node's wallet — directly reversing spec invariants #7 + #8 (below). The 503 is the architecture refusing the custodial inversion, not a config bug.
- 🟡 Review also flags: B2 PATCH accepts client-supplied addresses unverified; B3 `payments.status: active` written with no on-chain proof; C1 duplicated GitHub-App auth; C2 no tests on write-adapter/routes; C3 slug global-unique 409 cross-tenant oracle; C5 fat PATCH handler.

## Decisions Made (architect verdict — this is the realignment)

- **Honor the spec. The wizard is GOVERNANCE-ONLY.** Per `node-formation.md` #7 `FORMATION_IS_GOVERNANCE_ONLY` + #8 `CHILD_OWNS_OPERATOR_WALLET`: formation outputs `cogni_dao` + `payments.status: pending_activation`, and NEVER provisions/stores/administers operator wallets — the child node's own Privy app does that, later, in its own trust domain.
- **Retire PRD decision D5** ("operator-custodial for everyone"). It was a conscious-but-wrong call; the spec wins. New flow: `dao_pending → dao_formed → active(=published)`. No `wallet_ready`/`payments_ready` in the wizard path.
- **Publish the repo-spec that `/api/setup/verify` already returns** — it is server-derived (fixes B2) and already `pending_activation` (fixes B3). Do not build a new YAML; commit the one verify produced.
- **No new chain code (Derek hard rule).** This realignment DELETES chain code; payment activation stays in the existing `pnpm node:activate-payments` + `/setup/dao/payments` path, untouched.

## Next Actions

- [ ] **Delete** `app/api/v1/nodes/[id]/provision-wallet/route.ts`, `bootstrap/capabilities/node-wallet.ts`, `adapters/server/privy/operator-wallet-provisioner.ts` (+ its `adapters/server/index.ts` barrel export).
- [ ] **Collapse state machine** (`features/nodes/state-machine.ts`): `dao_formed --spec_published--> active`; drop `wallet_provisioned`/`split_deployed` events; `NODE_PROGRESS_STEPS` = Register → DAO → Published. Keep the DB enum unchanged (no migration — dead states are harmless). Update `state-machine.test.ts`.
- [ ] **Publish route** (`app/api/v1/nodes/[id]/publish/route.ts`): allow `dao_formed → active`; drop `operator_wallet`/`split` preconditions; commit the verify-returned `pending_activation` repo-spec (cogni_dao only). Replace `repo-spec-builder.ts buildCompleteRepoSpecYaml` with a pending_activation emitter or reuse `/api/setup/verify`'s `buildRepoSpecYaml`. Update `repo-spec-builder.test.ts`.
- [ ] **Dashboard** (`setup/nodes/[id]/NodeActionPanel.client.tsx`): `dao_formed` → single "Open repo-spec PR" button. Remove wallet + payments buttons.
- [ ] Reconcile the `nodes` row on candidate-a if a stale `wallet_ready`-expecting row blocks testing (VM access below).
- [ ] Push → CI green → flight → re-test wizard register → DAO → publish PR.
- [ ] Follow-ups (not blockers, file/scope as you go): B2 tighten PATCH to receipt-derived only; C1 extract shared `github-app-auth.ts`; C2 tests on publish route + GitHubRepoWriter (fake Octokit: 422 branch-exists, file-update, PR-exists, 404 install); C3 scope slug unique to `(ownerUserId, slug)` + opaque 409; C5 move PATCH body into a `features/nodes/update-node.ts` service.

## Risks / Gotchas

- **Do not re-add operator-custodial wallet provisioning.** If a future need arises, it requires a conscious `node-formation.md` amendment retiring #7/#8 with the custody/blast-radius/fork-away trade-offs argued — not a code change.
- Editing an applied migration is a no-op on existing DBs (drizzle tracks by `folderMillis`). Memory: `feedback_edited_migration_noop_on_applied_dbs`. 0029 is clean+single now; don't add 0030.
- Routes are session-auth → agent probes cap at 401. Authed UI E2E needs Derek's browser OR capture operator storageState (`docs/guides/candidate-auth-bootstrap.md`).
- candidate-a manual DB/VM ops are reconcile-to-git only (allowed per `devops-expert`). Key `/Users/derek/dev/cogni-template/.local/candidate-a-vm-key`, IP `84.32.9.111`.

## Pointers

| File / Resource                                                                 | Why it matters                                                                                     |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `docs/spec/node-formation.md` (invariants #4,#7,#8; "Payment Activation")       | The contract the wizard MUST honor — governance-only, child-owns-wallet, server-verified addresses |
| `nodes/operator/app/src/app/api/setup/verify/route.ts` (`buildRepoSpecYaml`)    | Already emits server-derived `pending_activation` repo-spec — publish should commit THIS           |
| `nodes/operator/app/src/app/api/v1/nodes/**` + `features/nodes/**`              | The v0 wizard backend to simplify                                                                  |
| `docs/guides/operator-wallet-setup.md` + `scripts/provision-operator-wallet.ts` | The child-node activation path that stays OUTSIDE the wizard                                       |
| `.claude/skills/poly-auth-wallets` + `packages/operator-wallet/AGENTS.md`       | Privy/custody expertise if activation work is later in scope                                       |
| PRD `node-registry-v0-prd` (operator `/knowledge`, contrib `...85a9d305`)       | v0 design — note D5 (operator-custodial) is now RETIRED by this handoff                            |
| Design review (pasted in Derek's 2026-05-30 message)                            | Full B1-B3 + C1-C7 list; B1/B2/B3 drive this realignment                                           |
