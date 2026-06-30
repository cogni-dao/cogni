---
work_item_id: task.5066
status: blocked
branch: derekg1729/attribution-main-merge-selection
last_commit: a3969ff37d
---

# Attribution → claimants e2e (operator)

## Mission

Pickup: you own making Cogni **operator attribution produce claimants end-to-end** — a weekly `CollectEpoch` that ingests git contributions and shows contributors on `/gov/epoch`. The crash that blocked everything is fixed and merged; the selection logic is written and unit-tested. One live blocker remains on candidate-a (below). git is **source #1 of N** — keep the pipeline source-agnostic; don't pigeonhole to git.

## Goal

End state: a `CollectEpoch` run resolves **`profileId=cogni-v0.1`**, `Selection policy applied … included>0`, and `epoch_receipt_claimants` rows created as `identity:github:<id>` (unresolved contributors are claimable later — `IDENTITY_BEST_EFFORT`).

**E2E validation (candidate-a):**

1. Flight PR #1892 head to candidate-a; confirm `curl https://test.cognidao.org/version` `.buildSha` == PR head SHA.
2. Trigger collect: `POST https://test.cognidao.org/api/v1/attribution/epochs/collect` (SIWE — use the cookie from `.local-auth/candidate-a-operator.storageState.json`; 5-min cooldown is normal, not a hang).
3. Read Loki `{env="candidate-a",service="scheduler-worker",component="ledger"}` → must show `profileId="cogni-v0.1"` + `included>0`.
4. candidate-a git stream is **synthetic `cogni-test-org`**, so `included>0` needs a merged-to-main PR by a non-excluded author in the open window — may need to seed one, or do the real proof on **prod** (real `Cogni-DAO` stream). The external test proves the logic deterministically.

## Start By Reading

- **RECALL FIRST (this was my process miss):** hub guide `GET /api/v1/knowledge/contrib-derek-claude-curitiba-d2965253-a68f04` — "How Cogni epochs go live end to end" (governance domain). Canonical pipeline map; states **boot-sync already exists**.
- `docs/spec/plugin-attribution-pipeline.md` (profiles + selection policies; built-in table now lists `cogni-v0.1`) and `docs/spec/attribution-ledger.md` (invariants: `WEIGHT_PINNING`, `IDENTITY_BEST_EFFORT`, `SOURCE_NO_ADAPTER`).
- `packages/temporal-workflows/src/workflows/collect-epoch.workflow.ts:115` — `attributionPipeline` is read from the **schedule input**, NOT epoch-pinned (only `weightConfig` is pinned).
- `packages/scheduler-core/src/services/syncGovernanceSchedules.ts` (`scheduleConfigChanged`, `updateSchedule` path) + `nodes/operator/app/src/adapters/server/temporal/schedule-control.adapter.ts:278` (`handle.update` → `action.args`).
- `nodes/operator/app/src/shared/config/repoSpec.server.ts:69` (`loadRepoSpec` reads `COGNI_REPO_ROOT/.cogni/repo-spec.yaml`) + `nodes/operator/app/Dockerfile:84` (bakes `nodes/operator/.cogni` → `/app/.cogni`, NOT root).
- `services/scheduler-worker/src/activities/ledger.ts:106-123` — claimants created only for `included` receipts → `identity:github:<id>`.

## Current State (facts)

- **#1890 MERGED** → main: reverted #519's fatal `SOURCE_NO_ADAPTER` throw (`resolveStreams` skips gracefully for webhook-only git) + `attribution.receipt_ingested` telemetry.
- **#1892 OPEN** (this branch). Commits: (a) `cogni.main-merge-selection.v0` policy + `cogni-v0.1` profile + registry/index/unit-tests; (b) `bootstrap/startup-reconcile.ts` boot self-reconcile via `getContainer()`; (c) **`activity_ledger` mirrored into `nodes/operator/.cogni/repo-spec.yaml`** (root `.cogni` was the wrong file — operator reads `nodes/operator`'s; same class as `bug.5087` `operator_wallet`).
- CI green on #1892. Flighted to candidate-a; deploy landed (`/version=a3969ff37d`); `verify-candidate (scheduler-worker)` flaked on transient VM cutover (not the fix).
- 🔴 **BLOCKER:** CollectEpoch runs (00:38, 00:43) STILL resolve `profileId=cogni-v0.0`. Boot-sync logs `Updated ledger_ingest (drift detected) updated:1`, but the schedule's stored workflow **input never flips to cogni-v0.1**. Epoch does NOT pin the profile, so that's ruled out.
- Knowledge: `attribution-e2e-health-scorecard` (governance) drafted on open contribution branch `contrib-derek-conductor-dereks-macbook-p-8b802745` — refresh after resolution.

## Design / Implementation Target

1. **Add the missing observability FIRST** (this is why I went in circles): one log in `syncGovernanceSchedules` dumping the resolved `attributionPipeline` from `getGovernanceConfig()` + the `desiredInput` it writes. Flight; read Loki. This deterministically settles suspect (a) vs (b).
2. **Suspect (a):** `getGovernanceConfig()` on the deployed operator returns `cogni-v0.0` → the operator isn't reading the `cogni-v0.1` repo-spec. Verify `COGNI_REPO_ROOT/.cogni/repo-spec.yaml` content in the running pod and that the a3969 image baked `nodes/operator/.cogni` with `cogni-v0.1`.
3. **Suspect (b):** config is `cogni-v0.1` but `updateSchedule` (in-place `handle.update`) doesn't apply new `action.args` to an existing schedule → fix by **recreating** the schedule (delete+create) on input drift, or fixing the Temporal update path.
4. **Reconcile the boot-sync duplication:** the hub guide says boot-sync already exists; `startup-reconcile.ts` may be redundant. Keep exactly ONE boot activation path; remove the dup.
5. **Must NOT regress:** #1890 graceful poll-skip (webhook-only git); `PROFILE_IMMUTABLE_PUBLISH_NEW` (`cogni-v0.0` stays registered); **no GH App key on scheduler-worker**; **no deploy-infra / `INTERNAL_OPS_TOKEN` dependency** for activation.
6. **Boundaries:** operator ledger config lives in `nodes/operator/.cogni/repo-spec.yaml` (NOT root, for runtime); selection policy is input-driven (not epoch-pinned); `weightConfig` IS epoch-pinned.

## Next Actions / Risks

- [ ] Recall the hub guide (RECALL_BEFORE_WRITE) before touching anything.
- [ ] Ship the resolved-`attributionPipeline` log (#1 above) → flight → read Loki → pick fix (a) or (b).
- [ ] Re-run the candidate-a E2E proof; if `included>0` can't be shown on synthetic test-org, prove on prod.
- Risk: `INTERNAL_OPS_TOKEN` is OpenBao-sealed and correctly NOT on the laptop — **don't chase it**; activation must be code (boot-sync), never a manual token POST.
- Gotcha: `playwright-cli` drops the httpOnly next-auth cookie (`bug.5059`) → trigger `/collect` via `curl` with the storageState cookie instead.
- Gotcha: `verify-candidate (scheduler-worker)` flakes on the candidate-a VM cutover; the deploy still lands — check `/version`, don't assume the flight failed.
