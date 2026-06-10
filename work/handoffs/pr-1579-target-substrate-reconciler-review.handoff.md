---
id: "handoff.pr-1579-target-substrate-reconciler-review"
type: handoff
work_item_id: ""
status: active
created: 2026-06-08
updated: 2026-06-08
branch: "codex/target-substrate-reconciler-spec"
last_commit: "cace4c0ead"
---

# Handoff: PR #1579 Target Substrate Reconciler Review

## Mission

Pickup: review and validate PR #1579 after the post-review refinements. The branch implements the candidate-a target substrate reconciler for nodeRef/node-formation app flights, keeping `deploy-infra.sh` and secret-value writes out of the app lane while reconciling target-local substrate before digest promotion.

## Goal

- Approve or refine the reconciler implementation after a fresh implementation review.
- E2E validation signal: a branch-ref `candidate-flight.yml` nodeRef dispatch reaches `verify-candidate` and proves `https://<slug>-test.cognidao.org/version` has `buildSha == source_sha`.
- Scorecard must include workflow URL, candidate URL, buildSha proof, and Loki evidence for `target_substrate_reconcile_summary`.

## Start By Reading

- `scripts/ci/reconcile-target-substrate.sh`
- `.github/workflows/candidate-flight.yml`
- `scripts/ci/tests/reconcile-target-substrate.test.sh`
- `scripts/ci/workflow-check.mjs`
- `docs/spec/target-substrate-reconciliation.md`
- `docs/spec/ci-cd.md` Axiom 21
- `docs/spec/node-ci-cd-contract.md` target substrate section

## Current State

- PR #1579 branch has two local follow-up commits after the original implementation:
  - `62b50bbde0 fix: surface target substrate reconcile failures`
  - `cace4c0ead docs: clarify target substrate observability`
- Focused local checks passed:
  - `bash scripts/ci/tests/reconcile-target-substrate.test.sh`
  - `bash scripts/ci/tests/assert-target-substrate.test.sh`
  - `node scripts/ci/workflow-check.mjs`
  - `git diff --check`
- Branch is pushed to PR #1579 at
  `cace4c0ead86eeeb881e783dacacb5d6f24abc14`; GitHub checks were in progress
  at the handoff time.
- No candidate-a nodeRef validation has run after these refinements.
- Existing untracked handoffs were left untouched:
  - `work/handoffs/pr-1577-target-substrate-e2e.handoff.md`
  - `work/handoffs/target-substrate-reconciler-implementation.handoff.md`

## Design / Implementation Target

1. Reconcile target-local substrate, wait for Argo-created objects, then assert read-only substrate before any digest promotion.
2. Preserve boundaries: no `deploy-infra.sh`, no OpenBao writes, no GitHub-secret fallback for pod DB credentials, no legacy `<target>-node-app-secrets`.
3. Failed reconciliation must be visible: Loki summary includes `status`, `failed_rows`, per-row `error_code`, and `report-status` names reconcile/assert failures before promotion.

## Next Actions / Risks

- [ ] Wait for PR #1579 GitHub checks at `cace4c0ead86eeeb881e783dacacb5d6f24abc14`.
- [ ] Review the two follow-up commits for shell edge cases and workflow status behavior.
- [ ] Pick or create one real node target whose candidate-a overlay consumes `<target>-env-secrets` and has a candidate-a ExternalSecret manifest.
- [ ] Run branch-ref `candidate-flight.yml` with `node_slug` and a published 40-char `source_sha`.
- [ ] Verify Loki has `workflow=candidate-flight kind=target_substrate_reconcile slot=candidate-a` with `status=success`.
- [ ] Verify `assert-substrate`, `flight`, and `verify-candidate` all pass.
- [ ] Post the candidate scorecard to PR #1579.
- Risk: current greenfield external nodes like `coulditbe` still consume legacy `<node>-node-app-secrets` and lack node-local candidate-a ExternalSecret manifests, so they will correctly fail before `/version` until a reviewable node overlay/ESO port lands.
- Risk: candidate-a OpenBao may still lack standalone DB role keys expected by the reconciler; that should fail with `openbao_values` and not fall back to GitHub secrets.

## Pointers

| File / Resource                                       | Why it matters                                                                                   |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| PR #1579                                              | Review surface and GitHub CI status                                                              |
| `scripts/ci/reconcile-target-substrate.sh`            | Main reconciler implementation and Loki summary schema                                           |
| `.github/workflows/candidate-flight.yml`              | Job ordering, promotion gates, and terminal status aggregation                                   |
| `scripts/ci/tests/reconcile-target-substrate.test.sh` | Fake-VM coverage for idempotence, waits, OpenBao failures, role failures, and redaction          |
| `scripts/ci/workflow-check.mjs`                       | Regression pins for no `deploy-infra.sh`, reconcile/assert gates, and terminal status visibility |
| `docs/spec/target-substrate-reconciliation.md`        | Updated decision contract and observability schema                                               |
