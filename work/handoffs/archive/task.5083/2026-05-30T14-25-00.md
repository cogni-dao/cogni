---
id: task.5083.handoff
type: handoff
work_item_id: task.5083
status: active
created: 2026-05-30
updated: 2026-05-30
branch: derekg1729/operator-node-registry-v0
last_commit: d8a1284e7
---

# Handoff: Operator node-registry v0 — setup wizard

## Context

- Goal: an operator setup wizard that takes a founder from "I want a node" → bootstrapped node (repo + DAO + payments) with no CLI, no manual YAML paste. Work item `task.5083`, PR **#1381**.
- v0 is **monorepo-internal**: a node is a new `nodes/<slug>/` directory in `Cogni-DAO/cogni` (how operator/poly/resy already live). NOT a forked standalone repo (that's vNext). See PRD knowledge entry `node-registry-v0-prd` (operator `/knowledge`, contribution `contrib-derek-claude-curitiba-85a9d305`).
- Postgres `nodes` table = live wizard state; `.cogni/repo-spec.yaml` = its git manifestation on publish. 6-state machine: `draft → dao_pending → dao_formed → wallet_ready → payments_ready → published`(=`active`).
- **HARD RULE from Derek (governs the open work):** do **not** build new chain-interaction code. Anything touching chain ops (DAO, Privy wallet, 0xSplits) must be **1-1 ported from existing workflows**. The one sanctioned exception: there is no existing *server-side* "create a Privy wallet" path (only the CLI), so porting that CLI's exact call server-side is allowed — be super sharp-eyed, change nothing else.

## Current State

- ✅ DAO formation works E2E on candidate-a (Derek drove it; `DAO_FORMED`, address populated, status bar advanced).
- ✅ Block-not-ready retry fixed (was the formation blocker): `isBlockNotReadyError` now matches Alchemy `Unknown block` + public `mainnet.base.org` `block not found` / `Requested resource not found` + geth `header not found`. Unit-tested.
- ✅ Register form: slug input (Base-only, chain locked). `users`-upsert before the FK insert (fixed an earlier 500).
- ✅ Migration hygiene clean: single `0029` (no `repo_url` UNIQUE — all monorepo nodes share one repo_url, slug is the unique key). No `0030` mush. candidate-a's stale constraint was dropped live to reconcile it to git. preview/prod clean by construction (never ran 0029).
- ✅ CI: 14/14 required green on `d8a1284e7`; flighted; serving on `https://test.cognidao.org`.
- 🔴 **BLOCKED at "Provision operator wallet":** the `provision-wallet` route 503s with `PRIVY_APP_ID and PRIVY_APP_SECRET must be set on the operator` — **even though all three `PRIVY_APP_ID/SECRET/SIGNING_KEY` are set on the operator pod** (verified via `kubectl exec env`). Wizard cannot advance past `dao_formed`.
- 🟡 UI: status bar segments not fixed-width (drift); the `?nodeId` DAO path skips the in-wizard repo-spec preview Derek wanted to see.

## Decisions Made

- 6 v0 decisions locked in PRD entry `node-registry-v0-prd` (template/monorepo, slug not URL, one publish PR, stops at `published`, operator-custodial Privy, users-upsert). Read it; do not relitigate.
- Migration trap + fix documented: editing an applied migration is a no-op on existing DBs (drizzle tracks by `folderMillis`, not hash). Memory: `feedback_edited_migration_noop_on_applied_dbs`.
- candidate-a manual DB ops are reconcile-to-git, allowed per `devops-expert` (only env where write-SSH is sanctioned). VM key: `/Users/derek/dev/cogni-template/.local/candidate-a-vm-key`, IP `84.32.9.111`.

## Next Actions

- [ ] **Root-cause the 503**: route reads `serverEnv().PRIVY_APP_ID` (same memoized `serverEnv()` the container uses to build `operatorWallet`). Add a temp presence-log in `nodes/operator/app/src/app/api/v1/nodes/[id]/provision-wallet/route.ts`, redeploy, confirm whether `serverEnv()` returns the var in *that* route context. Env is proven present on the pod — the gap is the read, not the secret.
- [ ] **1-1 port the wallet-create**: replace the bespoke `provisionOperatorWallet` thin adapter with the exact `PrivyClient({appId,appSecret}).wallets().create({chain_type:"ethereum"})` call from `scripts/provision-operator-wallet.ts` (create needs appId+appSecret only — NO signing key). Confirm it reads env the same way the container does.
- [ ] Verify the Split-deploy step (`/setup/dao/payments?nodeId=`) is a true 1-1 reuse of the existing payments-activation flow — chicken-egg order is create-wallet → address → deploy Split → runtime adopts wallet to sign (correct as designed).
- [ ] UI: make status-bar segments fixed-width/aligned (only the fill color moves) — `NodeStatusBar.tsx`. Pure CSS, no chain code.
- [ ] UI: surface the generated repo-spec to the user (dashboard or publish-review) — the `?nodeId` redirect currently skips the `FormationFlowDialog` YAML preview.
- [ ] Then: publish step (one monorepo PR writing `nodes/<slug>/.cogni/repo-spec.yaml`), re-flight, `/validate-candidate`.

## Risks / Gotchas

- **HARD STOP on new chain code** — port, don't invent. This is the reason the wallet step is blocked, not a quick patch.
- candidate-a is the only env with hand-touched DB state; it's reconciled to git now — don't add forward migrations to "fix" candidate-a.
- Routes are session-auth: agent probes cap at 401. Authed E2E needs Derek's browser (no operator candidate-a storageState captured) OR capture one per `docs/guides/candidate-auth-bootstrap.md`.
- `serverEnv()` is memoized (singleton, parses `process.env` once) — relevant to the 503 investigation.

## Pointers

| File / Resource | Why it matters |
| --------------- | -------------- |
| `docs/guides/operator-wallet-setup.md` + `docs/spec/operator-wallet.md` | Canonical operator-wallet chain flow to port from |
| `scripts/provision-operator-wallet.ts` | The ONLY existing wallet-create code (CLI) — port this verbatim |
| `packages/operator-wallet/` (+ `AGENTS.md`, `adapters/privy`) | `PrivyOperatorWalletAdapter` — the runtime adopt-and-sign path |
| `.claude/skills/poly-auth-wallets` | Per-tenant Privy wallet provisioning expertise (AEAD, CustodialConsent, signing) |
| `nodes/operator/app/src/bootstrap/container.ts` L734-775 | How the working operator wallet reads env + builds Privy adapter |
| `nodes/operator/app/src/shared/web3/node-formation/AGENTS.md` + `docs/spec/node-formation.md` | DAO formation web3 primitives + verify flow |
| `docs/spec/payments-design.md` + `nodes/operator/app/src/features/payments/AGENTS.md` | 0xSplits + payments activation to reuse |
| `nodes/operator/app/src/app/api/v1/nodes/**` + `features/nodes/**` | The v0 wizard backend (state machine, routes, repo-spec builder) |
| PRD `node-registry-v0-prd` (operator `/knowledge`) | Locked design + 6 decisions + node-lifespan-tooling sibling |
