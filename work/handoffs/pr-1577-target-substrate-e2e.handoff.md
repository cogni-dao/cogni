---
id: "handoff.pr-1577-target-substrate-e2e"
type: handoff
work_item_id: ""
status: needs_candidate_validation
created: 2026-06-08
updated: 2026-06-08
branch: "codex/node-ref-substrate-assert"
last_commit: "c687ff7501abeaafc2be878b3f857c46a05f124b"
---

# Handoff: PR 1577 Target Substrate Gate E2E

## Mission

Pickup: drive PR #1577 from green code checks to merge eligibility. The PR removes hidden `deploy-infra` provisioning from candidate app flight and replaces it with a fail-loud substrate assertion for node-ref and new node catalog flights. Your job is to prove the workflow behavior end-to-end on candidate-a, post the validation scorecard, then make the draft PR ready for implementation review.

## Goal

- PR #1577 is validated on candidate-a and ready for implementation review.
- E2E signal: a `candidate-flight.yml` run from `codex/node-ref-substrate-assert` exercises a real `node_slug/source_sha` flight, `assert-substrate` passes, no `deploy-infra` job runs, `verify-candidate` passes, and the target node serves `/version.buildSha == <source_sha>`.
- Scorecard signal: `/validate-candidate` or equivalent scorecard is posted to PR #1577, explicitly noting this is workflow/substrate behavior and tying proof to the candidate-flight run URL and candidate node URL.

## Start By Reading

- `.github/workflows/candidate-flight.yml`
- `scripts/ci/assert-target-substrate.sh`
- `scripts/ci/tests/assert-target-substrate.test.sh`
- `docs/spec/ci-cd.md` axioms 16, 18, 19, 21
- `docs/spec/node-ci-cd-contract.md` hosted artifact and flight sections
- PR #1577 review thread and latest commits

## Current State

- PR #1577: `https://github.com/Cogni-DAO/cogni/pull/1577`
- PR state: open, draft, mergeable.
- Latest head: `c687ff7501abeaafc2be878b3f857c46a05f124b`.
- GitHub checks at `c687ff7501` are green per `gh pr checks 1577 --repo Cogni-DAO/cogni`.
- Local focused validation passed:
  - `bash scripts/ci/tests/assert-target-substrate.test.sh`
  - `bash scripts/ci/tests/require-node-ref-vm.test.sh`
  - `node scripts/ci/workflow-check.mjs`
  - `shellcheck scripts/ci/assert-target-substrate.sh scripts/ci/tests/assert-target-substrate.test.sh`
- Not done: no candidate-a nodeRef flight proof has been posted for #1577 yet.
- Not merge-ready: draft PR, no candidate scorecard, no deploy_verified proof.

## Design / Implementation Target

1. App flight must promote digests only; it must not silently provision or repair broad VM/Compose substrate.
2. Substrate assertion is target-shaped: `TARGET`, `DEPLOY_ENVIRONMENT`, `APP_SOURCE_DIR`, `COGNI_CATALOG_ROOT`; `type=node` has implemented checks, while `type=service` and `type=infra` fail fast with explicit messages.
3. Future `type=service` and `type=infra` catalog additions, including OpenFGA and LiteLLM, must not be forced through node-shaped substrate checks.

## Next Actions / Risks

- [ ] Refresh local branch: `git fetch origin && git checkout codex/node-ref-substrate-assert && git pull --ff-only`.
- [ ] Pick an existing remote-source node with a known published `image_repository:sha-<source_sha>` image, such as `node-template`, `pandora`, `creative`, or `coulditbe`.
- [ ] Dispatch `candidate-flight.yml` from branch `codex/node-ref-substrate-assert` with `node_slug=<slug>` and `source_sha=<40-char source sha>`.
- [ ] Confirm workflow graph shows `assert-substrate` success and no `deploy-infra` job.
- [ ] Confirm `verify-candidate` succeeds and the node URL serves `/version.buildSha == <source_sha>`.
- [ ] Post a candidate validation scorecard to PR #1577 with workflow URL, candidate URL, buildSha proof, and notes about workflow-only scope.
- [ ] Update PR body if needed: it still may mention old `assert-node-substrate.sh` names; align it with `assert-target-substrate.sh`.
- [ ] Mark PR ready for review only after the scorecard is posted.
- [ ] After review approval, merge only if branch protection remains green and no newer target-substrate changes land unvalidated.

- Main risk: a plain PR-number candidate flight may no-op because this PR changes workflow/scripts, not app code. Use a real nodeRef dispatch to exercise the new gate.
- Main compatibility risk: OpenFGA is `type=infra`; it must stay in `candidate-flight-infra.yml` / `deploy-infra.sh`, not this app-flight assertion path.
- If candidate substrate is missing, the expected outcome is red/fail-loud with remediation text, not a hidden repair run.

## Pointers

| File / Resource                                    | Why it matters                                                                                        |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `https://github.com/Cogni-DAO/cogni/pull/1577`     | PR to validate and move out of draft.                                                                 |
| `.github/workflows/candidate-flight.yml`           | Removes `deploy-infra` from app flight and wires `assert-substrate`.                                  |
| `scripts/ci/assert-target-substrate.sh`            | The new substrate gate; target-shaped, node branch implemented.                                       |
| `scripts/ci/tests/assert-target-substrate.test.sh` | Focused fake SSH/kubectl/docker/Cloudflare coverage.                                                  |
| `docs/spec/ci-cd.md`                               | Source of truth for app flight, catalog, lane isolation, DNS reconciliation, and deploy verification. |
| `docs/guides/create-service.md`                    | Clarifies `type=service` versus `type=infra`; useful for OpenFGA alignment.                           |
