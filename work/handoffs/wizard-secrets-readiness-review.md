---
id: handoff.wizard-secrets-readiness-review
type: handoff
work_item_id: ""
status: active
created: 2026-06-09
updated: 2026-06-09
branch: derekg1729/wizard-secrets-readiness
last_commit: cc7b7e184e
---

# Handoff: Review PR #1582 — node secret-custody split (materialize / reconcile)

## Mission

Pickup (review): PR #1582 makes the wizard-birthed node secret lane match the
north star — `secret-materialize` becomes the sole OpenBao writer for a node, and
`reconcile-substrate` moves toward read-only. You own the implementation review:
confirm the split is correct, the custody boundaries hold, and the transitional
seams are honest (not silent debt). This is the runtime half; the env-genesis half
(VM DB creds → OpenBao) is a separate lane with its own guide.

## Goal

- Confirm `secret-materialize` writes only node-owned secrets and never reads VM
  `.env`; `reconcile-substrate` no longer double-writes app keys.
- Confirm the read-only assertion fails loud on a missing node DSN.
- Deploy proof (not yet done): a candidate-a flight whose `materialize-substrate`
  job runs, `reconcile-substrate` + `assert-substrate` pass, image flights, and
  `/version` serves for the target node. Run: `candidate-flight.yml -f pr_number=1582`.

## Start By Reading

- `docs/design/node-wizard-secret-setting.md` — phase custody contract + DB-cred
  table + falsifying gate (the decision record).
- `docs/spec/secrets-management.md` Invariants 15 (`DB_ROLE_CREDS_ARE_OPENBAO_OWNED`)
  - 16 (`NODE_SECRET_MATERIALIZATION_PRECEDES_SUBSTRATE_RECONCILE`).
- `docs/spec/node-baas-architecture.md` — why DB creds are node-owned, not shared.
- `scripts/ci/secret-materialize.sh` (new) and `scripts/ci/reconcile-node-substrate.sh` (diff).
- `docs/guides/vm-secrets-repair.md` — the paired env-repair lane (NOT this PR).

## Current State

- Five+ scoped commits (`scoped-commit: legacy-secret-custody [N]`), each
  cherry-pickable: materialize script, BaaS-alignment fix, reconcile split,
  flight wiring, assert DSN check, CI test wiring.
- Local proof: `bash -n` + shellcheck clean; `secret-materialize.test.sh`,
  `reconcile-node-substrate.test.sh`, `assert-target-substrate.test.sh` (incl.
  `FAKE_MISSING_DSN` negative) all PASS.
- CI: green pending on `cc7b7e184e` (a fake-bao jq portability fix for the unit job).
- NOT yet flighted to candidate-a — runtime lane unproven on a real node.
- `deploy_verified` is blocked on the env-repair lane seeding `cogni/<env>/_shared`.

## Design / Implementation Target

1. `secret-materialize` is the only phase holding the `<env>-writer` token; it
   generates source:agent keys (preserve-existing), inherits shared/human values
   transitionally, and **never reads VM `.env`** (Invariant 15 anti-fix).
2. `reconcile-substrate` seeds **only** DB DSNs (transitional, until
   `cogni/<env>/_shared` lands), then becomes fully read-only. It must not write
   source:agent app keys (the double-write that was removed).
3. Load-bearing logic stays in scripts; the `materialize-substrate` workflow job
   is orchestration only (checkout → ssh → `bash secret-materialize.sh`).
4. Must-not-regress: no secret value ever printed (key names only); no node gets a
   `<slug>-node-app-secrets` Secret; assert stays read-only.

## Next Actions / Risks

- [ ] Confirm CI green on head `cc7b7e184e`.
- [ ] Flight `candidate-flight.yml -f pr_number=1582`; confirm `materialize-substrate`
      runs and substrate asserts green on a node target (not just operator).
- [ ] Verify `/version` + the node's own request in Loki at the deployed SHA.
- [ ] Review the transitional seams: DSN-seed-in-reconcile + blind `inherit_shared_value`
      scan are explicitly marked for the `_shared` / `inheritFrom` follow-ups.
- Risk: a flight may resolve target=operator (substrate skipped) — then the
  materialize lane isn't exercised; force a node-affecting change to target a node.
- Risk: this is bug.5002-class (DB auth). The falsifying gate (delete VM `.env`
  `APP_DB_PASSWORD`, prove green from OpenBao only) belongs to the env-repair lane.

## Pointers

| File / Resource                                                                                  | Why it matters                                                                                 |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `scripts/ci/secret-materialize.sh`                                                               | New sole-writer; review fail-loud + no-`.env` + token boundary                                 |
| `scripts/ci/reconcile-node-substrate.sh`                                                         | DSN-only seed; confirm app-key write + blind scan are gone                                     |
| `scripts/ci/assert-target-substrate.sh`                                                          | Read-only; new DATABASE_URL presence check                                                     |
| `scripts/setup/lib/reconcile-secrets.sh`                                                         | Shared engine (`seed_node_app_secrets`, `derive_secret`, `_resolve_node_value`) reused by both |
| `.github/workflows/candidate-flight.yml`                                                         | `materialize-substrate` job + report-status surfacing                                          |
| `scripts/ci/tests/{secret-materialize,reconcile-node-substrate,assert-target-substrate}.test.sh` | Fakes-only regression coverage                                                                 |
| `docs/guides/vm-secrets-repair.md`                                                               | Paired env-repair lane (other dev); not this PR                                                |
