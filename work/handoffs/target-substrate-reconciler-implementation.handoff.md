---
id: "handoff.target-substrate-reconciler-implementation"
type: handoff
work_item_id: ""
status: active
created: 2026-06-08
updated: 2026-06-08
branch: "codex/target-substrate-reconciler-spec"
last_commit: "9e824aeab100a4020eb6a670031e3f911337e1cc"
---

# Handoff: Target Substrate Reconciler Implementation

## Mission

Pickup: implement and validate the narrow target substrate reconciler designed in `docs/spec/target-substrate-reconciliation.md`. This follow-on owns the missing nodeRef launch bridge after #1577: a newly formed node with a published child image and merged operator deploy footprint should flight to `candidate-a`, reconcile target-local substrate, pass read-only assertion, promote only its digest, and serve `/version.buildSha == sourceSha` without manual VM edits or broad `deploy-infra.sh`.

## Goal

- `candidate-flight.yml` has a `reconcile-substrate` job before `assert-substrate` for `type=node` targets.
- `scripts/ci/reconcile-target-substrate.sh` reconciles only target-local substrate: AppSet/DNS if still owned there, edge/Caddy route, namespace, ESO ExternalSecret, Postgres DB, Doltgres DB, and `COGNI_NODE_DBS` membership.
- E2E validation proves a real nodeRef flight from the implementation branch ref succeeds: workflow URL, candidate URL, Loki reconcile summary, and `https://<slug>-test.cognidao.org/version` `buildSha == <sourceSha>`.

## Start By Reading

- `docs/spec/target-substrate-reconciliation.md`
- `docs/spec/ci-cd.md` Axioms 4, 11, 16, 18, 19, 21
- `docs/spec/node-ci-cd-contract.md` target substrate / nodeRef sections
- `docs/spec/secrets-management.md` Invariants 2, 3, 5, 9, 15
- `.claude/skills/devops-expert/SKILL.md`
- `.claude/skills/cicd-secrets-expert/SKILL.md`
- `.github/workflows/candidate-flight.yml`
- `scripts/ci/assert-target-substrate.sh`
- `scripts/ci/deploy-infra.sh` DB, Caddy, and catalog-derived env sections only

## Current State

- #1577 is merged into `origin/main` at `3e01e758a8`; app flight now asserts node substrate before nodeRef flight and does not run `deploy-infra.sh`.
- The reconciler design branch is `codex/target-substrate-reconciler-spec`, latest commit `9e824aeab1`.
- The design is docs-only. No reconciler script, workflow job, DB helper extraction, or tests exist yet.
- The spec requires ESO-only pod secrets for nodeRef flight; legacy `<target>-node-app-secrets` consumers must fail.
- Existing untracked file `work/handoffs/pr-1577-target-substrate-e2e.handoff.md` predates this work; leave it alone unless explicitly asked.

## Design / Implementation Target

1. Reconcile target-local substrate, then run `assert-target-substrate.sh` as the read-only proof gate before digest promotion.
2. Keep app flight out of broad env provisioning: no `deploy-infra.sh`, no source rebuild, no OpenBao value writes, no GitHub-env fallback for pod-consumed DB credentials.
3. Preserve loud failures for unowned prerequisites: missing VM, missing base Compose services, missing OpenBao/ESO, missing `<env>-db-reader`, missing OpenBao values, legacy plain-Secret consumers, unsupported target types.

## Next Actions / Risks

- [ ] Rebase/fetch `origin/main` before coding and confirm this branch still contains the spec commit.
- [ ] Implement `scripts/ci/reconcile-target-substrate.sh` with `type=node` dispatch and redacted JSON summary output.
- [ ] Extract or reuse narrow DB/Caddy helpers; do not shell out to `deploy-infra.sh` wholesale.
- [ ] Add focused fake-VM tests for edge env/Caddy, ESO-only secret contract, Postgres, Doltgres, `COGNI_NODE_DBS`, idempotence, and negative OpenBao/db-reader cases.
- [ ] Wire `candidate-flight.yml`: `reconcile-substrate` must precede `assert-substrate`; `flight` must still require assertion success.
- [ ] Extend `scripts/ci/workflow-check.mjs` to pin job ordering and forbid `deploy-infra.sh` in `candidate-flight.yml`.
- [ ] Update `docs/spec/ci-cd.md`, `docs/spec/node-ci-cd-contract.md`, and relevant skills only after behavior is implemented.
- [ ] Run focused local checks from the spec, then push and watch GitHub CI.
- [ ] Dispatch a real nodeRef candidate flight from the implementation branch ref with `gh workflow run candidate-flight.yml --ref <branch> -f node_slug=<slug> -f source_sha=<sha>`.
- [ ] Post the `/validate-candidate` scorecard with workflow URL, candidate URL, buildSha proof, and Loki query/result for `target_substrate_reconcile_summary`.

- Main risk: current live overlays or node manifests may still consume `<target>-node-app-secrets`; per spec, do not preserve that bridge in the reconciler.
- DB role credential handling is the sharp edge: create missing DBs/roles only from OpenBao-sourced values or fail.
- Doltgres must be included; a green `/version` without `knowledge_<target>` is not the node-wizard E2E goal.
- Branch-ref workflow dispatch is required before merge because this PR changes workflow YAML/scripts.
- If no external node has a healthy child `sha-<sourceSha>` artifact, coordinate a throwaway node source build first; do not substitute operator-only flight as proof of nodeRef substrate.

## Pointers

| File / Resource                                | Why it matters                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `docs/spec/target-substrate-reconciliation.md` | Source of truth for reconciler scope, boundaries, and validation.         |
| `.github/workflows/candidate-flight.yml`       | Workflow graph to insert `reconcile-substrate` before `assert-substrate`. |
| `scripts/ci/assert-target-substrate.sh`        | Read-only proof gate the reconciler must satisfy.                         |
| `scripts/ci/deploy-infra.sh`                   | Existing Caddy/DB/catalog logic to extract narrowly, not call wholesale.  |
| `docs/spec/secrets-management.md`              | Defines ESO-only pod secret shape and OpenBao-owned DB role credentials.  |
| `.claude/skills/cicd-secrets-expert/SKILL.md`  | Operational guardrails for secrets and forbidden fallbacks.               |
| `.claude/skills/devops-expert/SKILL.md`        | CI/CD anti-patterns, especially no broad infra mutation from app flight.  |
| `scripts/ci/workflow-check.mjs`                | Place to pin workflow invariants so the design cannot regress silently.   |
