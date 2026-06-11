---
id: "prod-openfga-doltgres-drift"
type: handoff
work_item_id: ""
status: active
created: 2026-06-10
updated: 2026-06-10
branch: "fix/doltgres-superuser-selfheal"
last_commit: "d20fb3fc03"
---

# Handoff: Wire OpenFGA on prod — blocked by doltgres superuser credential drift

## Mission

Pickup: Get the OpenFGA store wired on production so #1604's access-request/approve
flow stops 503ing — the last gate before the prod operator node-wizard E2E. The
OpenFGA gap is a SYMPTOM. The real blocker is a **doltgres superuser password
drift** that fails `node-substrate` → halts the promote chain before
`deploy-infra` Step-6.6a (bootstrap-openfga) can run. You own getting prod
green (doltgres healthy → deploy-infra completes → OpenFGA store created).

## Goal

- Prod promote (`promote-and-deploy.yml`, production, nodes=operator) runs fully
  green: `node-substrate(operator)` → `promote-k8s` → `deploy-infra` →
  `OPENFGA_STORE_ID` set → operator restart picks it up.
- E2E signal: prod `/readyz` 200, buildSha stays `1b45ded967d7`,
  `/api/v1/knowledge/contributions` stays 200, and the #1604 approve flow no
  longer 503s.
- Workflow run is the proof (a real `gh` run URL), NOT a hand-promotion.

## Start By Reading

- `scripts/ci/deploy-infra.sh` lines ~855 (derive_secret), ~1064–1090 (my doltgres
  SSOT resolver + provision), ~1519 (per-node DOLTGRES_URL composition).
- `scripts/ci/reconcile-node-substrate.sh` lines ~272–286 (doltgres SSOT read),
  ~355–360 (doltgres-provision invocation).
- `infra/compose/runtime/doltgres-init/provision.sh` (connects as `postgres`, no
  self-heal).
- PR #1615 (this branch) — the partial fix + full root-cause writeup.
- `scripts/ci/secret-materialize.sh` ~200–215 (DSN composition; sole OpenBao writer).

## Current State (facts)

**Drift map (prod, verified 2026-06-10 via prod kubeconfig, read-only):**

| Value | Source (DO NOT paste the value anywhere) | Authenticates vs live volume? |
| --- | --- | --- |
| Live doltgres volume / running operator pod (X) | `kubectl -n cogni-production exec <operator-pod> -- printenv DOLTGRES_URL` | YES |
| `derive_secret(doltgres-root, POSTGRES_ROOT_PASSWORD)` (Y) | computed in deploy-infra.sh | NO — the wrong outlier |
| OpenBao `cogni/production/operator` DOLTGRES_URL (now) | `bao kv get cogni/production/operator` | = X, YES (aligned) |

> SECURITY: X is the shared doltgres SUPERUSER password for the whole prod
> knowledge plane. It must never be written to a file or chat. It is exposed in
> this session's transcript (operator error 2026-06-10) → **rotation required**
> (see Next Actions).

- Root cause CONFIRMED: the live doltgres volume superuser password (X) ≠ the
  value the lever re-derives from `POSTGRES_ROOT_PASSWORD` (Y). Almost certainly
  from today's prod doltgres restore (`.local/doltgres-knowledge-20260610-prod-predelete.tgz`).
- `materialize` is idempotent and does NOT overwrite OpenBao DOLTGRES_URL
  (`created=0 unchanged=23`). OpenBao SSOT = X, stable. (My earlier "oscillation"
  theory was wrong.)
- PR #1615 (commits bd84e9b0a6 + d20fb3fc03) sources the doltgres-provision
  connect password from OpenBao DOLTGRES_URL (X) in reconcile + deploy-infra.
  **Proven**: in run `27316129084`, `node-substrate(operator)` PASSED — first time
  the doltgres 28P01 cleared. CI green; safe-by-construction (no ALTER).
- **But the fix is INCOMPLETE — two landmines remain:**
  1. `deploy-infra.sh` writes `DOLTGRES_PASSWORD=Y` (derived) into the VM's
     `RUNTIME_ENV` at line ~858, BEFORE my resolver (~1074) reassigns it. So the
     VM `.env` persists the WRONG Y. (deploy-infra's own doltgres-provision was
     fixed to read operator's URL first, but RUNTIME_ENV stays poisoned.)
  2. `reconcile-node-substrate.sh` silently falls back to RUNTIME_ENV's
     `DOLTGRES_PASSWORD` (= poisoned Y) when its OpenBao read returns empty →
     transient 28P01. This is the likely cause of run `27316464874`'s
     `node-substrate` failure (identical code path for operator, env-driven).
- Prod is HEALTHY right now (readyz 200, knowledge 200, buildSha `1b45ded`).
  deploy-infra has NEVER completed, so no prod secret/operator was mutated by
  these runs. #1604 is live (shipped earlier via deploy-branch digest — note:
  that was a direct `deploy/production-operator` commit, NOT a workflow run).

## Design / Implementation Target

1. **Durable fix = fga-dev's pattern (PR #1613) applied to doltgres**: stop
   deriving the doltgres superuser from `POSTGRES_ROOT_PASSWORD`. Make it an
   OpenBao-owned STORED secret seeded to the live value X. Then derived-Y never
   enters; RUNTIME_ENV, reconcile, deploy-infra, materialize all converge on X
   permanently. This is convergent with #1613 — coordinate, don't collide.
2. **Minimum to unblock tonight** (if not doing #1 yet): (a) in deploy-infra,
   resolve the SSOT BEFORE the RUNTIME_ENV write (or rewrite the RUNTIME_ENV
   line after resolving) so the VM `.env` gets X; (b) make reconcile fail-loud
   (not fall back to Y) when the OpenBao SSOT read is empty.
3. **Boundary that must hold**: NON-destructive — never `ALTER` the doltgres
   superuser or re-key the volume (operator depends on X; an ALTER mid-flight
   503s knowledge). Converge everything ON the live volume value X.
4. **Regression that must not happen**: do not let ESO sync a wrong DOLTGRES_URL
   to `operator-env-secrets` → Reloader restart → operator gets Y → knowledge
   28P01. (Hasn't happened; OpenBao is X. Keep it that way.)

## Next Actions / Risks

- [ ] Coordinate with fga-dev (#1613) + dev2 (provision-deploy-split, #1607
      merged as 1b45ded): all three edit `provision.sh`/`deploy-infra.sh`. Decide
      whether the doltgres-superuser-as-OpenBao-secret rides #1613 or stays #1615.
- [ ] Harden #1615 per Target #2 (RUNTIME_ENV gets X; reconcile fail-loud).
- [ ] Re-dispatch scoped prod promote and watch node-substrate → deploy-infra →
      OpenFGA bootstrap (command below). Verify the goal signals.
- [ ] Name the same-day sync-porter to `Cogni-DAO/cogni` HUB for the substrate edit.
- Risk: blind re-dispatch with the current (incomplete) fix is ~50% flaky
  (transient OpenBao read → poisoned-Y fallback). Harden first.
- Risk: each failed prod promote runs a full deploy-infra attempt; it dies at
  doltgres-provision BEFORE mutating prod, so it's safe — but don't assume that
  holds once doltgres passes (deploy-infra then recomposes secrets + restarts).

## Pointers

| File / Resource | Why it matters |
| --------------- | -------------- |
| PR #1615 (branch `fix/doltgres-superuser-selfheal`) | partial fix + full root-cause |
| PR #1613 (fga-dev, openfga-substrate-unification) | the OpenBao-SSOT pattern to extend to doltgres |
| `scripts/ci/deploy-infra.sh` :858, :1074, :1519 | RUNTIME_ENV poison + resolver + DSN compose |
| `scripts/ci/reconcile-node-substrate.sh` :279, :355 | SSOT read + provision invocation |
| run `27316129084` | node-substrate PASS (doltgres fix proven) |
| run `27316464874` | node-substrate FAIL (poisoned-Y fallback) |
| `.local/production-kubeconfig.yaml` | read-only prod diagnosis (operator pod env = live X) |
| prod live doltgres pw X | REDACTED — read from operator pod env at use time; never store |
| Re-dispatch | `gh workflow run promote-and-deploy.yml --ref fix/doltgres-superuser-selfheal -f environment=production -f source_sha=1b45ded967d7798c3c1ee74f7422585e6a80f394 -f build_sha=1b45ded967d7798c3c1ee74f7422585e6a80f394 -f nodes=operator -f skip_infra=false` |
