---
id: "substrate-finalization-dev-manager"
type: handoff
work_item_id: ""
status: active
created: 2026-06-10
updated: 2026-06-10
branch: "chore/substrate-finalization-handoff"
last_commit: ""
---

# Handoff: Substrate Finalization Dev Manager (OpenFGA · Doltgres · Temporal) + secret rotation

## Mission

Pickup: You own the coordination of **three substrate finalizations** — OpenFGA,
Doltgres, Temporal — plus one **P0 security cleanup** (a leaked shared doltgres
superuser credential). All three lanes edit the same substrate files
(`scripts/ci/deploy-infra.sh`, `provision.sh`, `reconcile-node-substrate.sh`,
`secret-materialize.sh`), so uncoordinated they **collide**. Your job is to
sequence them through one-PR-at-a-time, rebased on `main`, each with a named
same-day sync-porter to the `Cogni-DAO/cogni` HUB. `#1607` (provision-deploy-split)
already merged as `1b45ded`; rebase everything on current `main`.

## Goal

- All three substrate lanes merged + deploy_verified; prod OpenFGA store wired so
  #1604's access-request/approve flow stops 503ing.
- The leaked doltgres superuser credential rotated; no live secret in any
  transcript/file is still valid.
- E2E proof: prod `/readyz` 200, buildSha holds, `/api/v1/knowledge/contributions`
  200, approve flow 200, all via real workflow runs (not hand-promotions).

## Start By Reading

- `work/handoffs/prod-openfga-doltgres-drift.handoff.md` (Doltgres deep-dive — the
  full drift map, the proven-but-incomplete fix, the two landmines).
- PR #1613 (OpenFGA), PR #1615 (Doltgres). Their diffs against the shared files.
- `scripts/ci/deploy-infra.sh` :855 (derive_secret), :1064–1090 (doltgres SSOT),
  :1519 (per-node DOLTGRES_URL compose); `secret-materialize.sh` :200–215.

## Current State (facts)

### P0 — SECRET ROTATION (do first)
During doltgres debugging on 2026-06-10, the **active shared doltgres superuser
password** (the `postgres` user on the prod doltgres / knowledge data plane,
shared across ALL dolt nodes) was printed in plaintext into an agent session
transcript. Files were scrubbed and it was **never committed to git**, but the
**transcript exposure is permanent → treat the credential as compromised.**
- Rotation path (careful — same fragile cred path as the Doltgres lane): set a new
  superuser password on the live prod doltgres volume (the current password lives
  only in the running operator pod's `DOLTGRES_URL` env) → update OpenBao
  `cogni/<env>/<node>/DOLTGRES_URL` for every node → ESO sync → operator restart.
- Rotate candidate-a / preview equivalents too if the value is shared across envs.
- The Doltgres lane's durable fix (below) is the natural vehicle for this rotation.

### Lane 1 — OpenFGA (PR #1613, owner: fga-dev, branch openfga-substrate-unification)
- CI green. Phase A: dedicated `openfga` Postgres role on the OpenBao SSOT,
  store-preserving ownership migration (#1604 continuity held), DSNs off-root,
  fail-loud. **Architecture approved** — it is the correct pattern.
- `fail-loud no-fallback` is safe HERE (the openfga role is on main Postgres, which
  `db-provision` can `ALTER ROLE … PASSWORD` to reconcile/self-heal — unlike
  doltgres). Their candidate-a test (seed → flight → rotate pw → zero 28P01 → 200)
  is the right proof.
- NOT deploy_verified. Needs candidate-a flight + `/validate-candidate`, lane
  coordination, and a named sync-porter.
- **The prod OpenFGA store is still unbootstrapped (approve 503s)** — it bootstraps
  inside `deploy-infra` Step-6.6a, which never runs while Lane 2 is broken. So
  #1613's "sequence after prod is green" is BLOCKED ON Lane 2.

### Lane 2 — Doltgres (PR #1615, branch fix/doltgres-superuser-selfheal @ d20fb3fc03)
- Root cause: the live prod doltgres superuser password DRIFTED from the value the
  lever re-derives from `POSTGRES_ROOT_PASSWORD` (almost certainly today's prod
  doltgres restore — `.local/doltgres-knowledge-20260610-prod-predelete.tgz`). This
  fails `node-substrate` (28P01 at doltgres-provision) → halts the promote chain
  before OpenFGA bootstrap.
- Partial fix (source the provisioner pw from OpenBao `DOLTGRES_URL`) is PROVEN —
  `node-substrate(operator)` passed in run `27316129084`. CI green, no ALTER.
- INCOMPLETE — two landmines: (a) deploy-infra writes the wrong derived pw into the
  VM `.env` before the resolver runs; (b) reconcile silently falls back to that
  poisoned value on a transient OpenBao read miss → 28P01 (caused run
  `27316464874` failure).
- **Durable fix = the exact #1613 pattern**: make the doltgres superuser an
  OpenBao-owned STORED secret (not derived). Then derived-Y never enters and
  everything converges on the live value permanently. **Fold #1613 + #1615 into one
  coherent "creds off-root, OpenBao SSOT" effort** — and use it to land the P0
  rotation.

### Lane 3 — Temporal
- Third substrate finalization. Specifics not captured here — scope it from open
  PRs / work items. `temporal-postgres` / `temporal` are compose-infra services in
  `deploy-infra.sh`; relevant prior work includes the "Temporal replaces
  workflow_run chaining" / release-control-plane effort. Confirm owner and whether
  it also edits the shared substrate files (likely → same collision set).

### Prod state
Healthy — `/readyz` 200, knowledge 200, buildSha `1b45ded` (#1604 live). Tonight's
prod promote attempts ALL died at doltgres-provision BEFORE mutating prod, so no
prod secret/operator was changed by them. #1604 itself was shipped earlier via a
direct `deploy/production-operator` digest commit (NOT a workflow run) — re-ship it
properly through the lever once Lane 2 lands.

## Design / Implementation Target

1. Off-root, OpenBao-owned stored secrets for BOTH openfga and doltgres superuser
   (one pattern, two consumers). Eliminate `derive_secret` for these.
2. Converge on the LIVE volume value (never ALTER a live doltgres superuser
   mid-flight — operator depends on it; an ALTER 503s knowledge). Rotation is a
   deliberate, coordinated op, not a side effect.
3. Regression that must not happen: ESO syncing a wrong DOLTGRES_URL → operator
   restart → knowledge 28P01.

## Next Actions / Risks

- [ ] P0: rotate the exposed doltgres superuser credential (all envs that share it).
- [ ] Fold #1613 + #1615 into one substrate PR (or strictly sequence them), rebased
      on `main`, with a named sync-porter.
- [ ] Harden the doltgres fix (RUNTIME_ENV gets the live value; reconcile fail-loud
      not silent-fallback).
- [ ] Scope Lane 3 (Temporal): owner, PR, shared-file impact.
- [ ] After Lane 2 lands: re-dispatch scoped prod promote → verify OpenFGA bootstrap
      → flight #1613 on candidate-a → `/validate-candidate`.
- Risk: blind re-dispatch of the current (incomplete) doltgres fix is ~50% flaky.
- Risk: three PRs through `deploy-infra.sh` will conflict — one at a time.

## Pointers

| File / Resource | Why it matters |
| --------------- | -------------- |
| `work/handoffs/prod-openfga-doltgres-drift.handoff.md` | Doltgres deep-dive (root cause + drift map + landmines) |
| PR #1613 (fga-dev) | OpenFGA Phase A — the OpenBao-SSOT pattern to extend to doltgres |
| PR #1615 (fix/doltgres-superuser-selfheal) | Doltgres partial fix + writeup |
| runs `27316129084` (pass) / `27316464874` (fail) | doltgres fix proof + the transient-fallback failure |
| `.local/production-kubeconfig.yaml` | read-only prod diagnosis (operator pod env holds the live doltgres pw) |
| `scripts/ci/deploy-infra.sh`, `secret-materialize.sh`, `reconcile-node-substrate.sh`, `provision.sh` | the shared substrate files all three lanes touch |
