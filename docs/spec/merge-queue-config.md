---
id: spec.merge-queue-config
type: spec
title: Merge Queue Required Checks — Policy & Empirical Constraints
status: active
trust: reviewed
summary: Required-status-checks policy for the merge queue. GitHub's queue waits forever for required checks whose workflows lack a `merge_group:` trigger — verified empirically. Spec defines the resulting flat single-tier policy, the stub-job escape hatch for "PR-only intent" checks, and the GitLab Merge Trains port.
read_when: Adding/removing a required status check; debugging a stuck merge queue; setting up `main`-branch protection on a Cogni-DAO node fork; planning the GitLab vFuture port.
implements: []
owner: cogni-dev
created: 2026-04-28
verified: 2026-04-28
tags:
  - ci-cd
  - branch-protection
  - merge-queue
---

# Merge Queue Required Checks — Policy & Empirical Constraints

## Context

The merge queue's load-bearing job is **anchoring preview-environment image content to the merged tree** (see [development-lifecycle.md](./development-lifecycle.md) Step 8 + task.0391). PR #1083 (the merge-queue rollout) got stuck in the queue waiting for `CodeQL` and `Validate PR title` to report on the queue ref — they never did, because their workflows have no `merge_group:` trigger. The natural intuition was to express **two distinct gates** (full strictness for PR merge, narrow set for the queue) on the assumption that GitHub Rulesets supports event-specific required-checks lists. That assumption was tested and falsified.

## Goal

Define the required-status-checks policy that actually works on GitHub today, capture the empirical finding behind it, and specify the portable shape for GitLab Merge Trains in vFuture. The fixture in `infra/github/` is canonical for any node-shaped fork.

## Non-Goals

- Defining the candidate-a `deploy_verified` gate — see [development-lifecycle.md](./development-lifecycle.md).
- Per-node merge queues — discarded after analysis (see task.0391); revisit if N > 5 nodes or queue depth becomes a real bottleneck.
- Reconciler workflows that auto-apply the config — deferred until drift becomes a recurring issue.

## Core Invariants

1. **REPORT_OR_DON'T_REQUIRE**: A required status check MUST be produced by a workflow that fires on both `pull_request:` AND `merge_group:` events. PR-only workflows cannot be required — the queue would wait forever for a status that never arrives. Empirically validated.
2. **QUEUE_GATE_IS_TREE_CORRECTNESS**: The queue's required-set's load-bearing entry is the image-build aggregator (`manifest`), which proves the rebased tree built into a usable image. Other entries are cheap deterministic checks (`static`, `unit`, `component`).
3. **STUB_JOB_FOR_PR_INTENT**: When a check's "real validation" only makes sense on PR-time (e.g., title convention, security scan, candidate-a flight), the workflow MAY add a `merge_group:` trigger with a no-op passthrough step that emits a success status with the same context name. This makes the check visible on both events without doing duplicate work on the queue ref. **Canonical example: `candidate-flight`** — required-on-PR (every external-agent contribution must dispatch `/vcs/flight` and pass), but explicitly NOT required-on-merge-queue (the queue's rebased SHA is different from the PR head; re-flighting it would conflict with the slot lease and waste a candidate-a deploy). Implementation: `candidate-flight.yml` adds `merge_group:` trigger + a passthrough job that emits `candidate-flight` success on merge_group events. Spec'd; implementation tracked in task.0414.
4. **CONFIG_AS_CODE**: The set of required checks is committed to `infra/github/branch-protection.json`. Drift between live and committed is detectable (`gh api ... | diff`).

## The Empirical Finding (2026-04-28)

Hypothesis tested in `Cogni-DAO/test-repo` PR #53:

> When a required status check's workflow has no `merge_group:` trigger, does GitHub's merge queue (a) wait forever or (b) skip it because no workflow is registered to produce it?

Test setup:

- `mq-test-both.yml` — fires on `pull_request` AND `merge_group`. Always passes.
- `mq-test-pr-only.yml` — fires on `pull_request` only. Always passes.
- Branch protection: required checks `[mq-test-both, mq-test-pr-only]` + merge queue enabled (Rulesets API).

Observed behavior on the queued PR:

```
mq-test-pr-only Expected — Waiting for status to be reported
Required
@github-actions
mq-test-both Successful in 2s
```

Queue stayed in `AWAITING_CHECKS` indefinitely. **Outcome (a) confirmed.** Rulesets does not change this behavior vs classic branch protection — both surface the same merge-queue waiting semantics.

This kills the "Tier 1 strict / Tier 2 narrow via Rulesets" approach. The remaining options are:

- (i) Restrict required-checks to those that fire on both events (chosen). Lose pre-merge enforcement of CodeQL and Validate PR title — they remain advisory on PR-time but cannot block merge.
- (ii) Stub-job pattern (see `STUB_JOB_FOR_PR_INTENT` invariant) — add `merge_group:` triggers + passthrough success to PR-only workflows so they can be required.

We ship (i) today (smaller blast radius, no per-workflow edits) and reserve (ii) for cases where losing the PR-only check as a hard gate is unacceptable.

## Required Status Checks (canonical set)

Set committed to [`infra/github/branch-protection.json`](../../infra/github/branch-protection.json):

| Context     | Workflow       | Why required                                                                                           |
| ----------- | -------------- | ------------------------------------------------------------------------------------------------------ |
| `static`    | `ci.yaml`      | Typecheck + lint. Cheap; catches base-incompatibility on rebase.                                       |
| `unit`      | `ci.yaml`      | Unit + format + arch + docs. Cheap; catches base-incompatibility on rebase.                            |
| `component` | `ci.yaml`      | Testcontainers component-level integration.                                                            |
| `manifest`  | `pr-build.yml` | **Load-bearing**: rebased-tree image build. Without this, `flight-preview` re-tags pre-rebase content. |

All four workflows fire on both `pull_request:` and `merge_group:`.

Excluded from required (advisory on PR-time only):

| Context             | Workflow                  | Why excluded from required                                                                                                                                               |
| ------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CodeQL`            | (org-level default-setup) | No `merge_group:` trigger. Required → queue waits forever (see Empirical Finding). Still scans on PR + reports to Security tab.                                          |
| `Validate PR title` | `pr-lint.yaml`            | No `merge_group:` trigger. Title convention is honor-system post-queue.                                                                                                  |
| `stack-test`        | `ci.yaml`                 | Fires on `merge_group` but is flaky; ~10 min on the rebased candidate doubles flake surface. Real integration validation lives at candidate-a via `/validate-candidate`. |

### Pending — `candidate-flight` (task.0414)

`candidate-flight` is the contract gate for external-agent contributions: every PR must dispatch `/vcs/flight` and pass before merge. It is therefore required-on-PR. But it MUST NOT gate the merge queue — the queue's rebased SHA differs from the PR head, and re-flighting it would conflict with the candidate-slot lease and waste a candidate-a deploy.

This is the canonical use of `STUB_JOB_FOR_PR_INTENT`: `candidate-flight.yml` will gain a `merge_group:` trigger with a passthrough job that emits `candidate-flight` success on merge_group events. Implementation tracked in `task.0414`. Once shipped, the canonical required set becomes `unit, component, static, manifest, candidate-flight` — the first stub-job-pattern entry in the live config.

## Implementation — Classic Protection (checks) + a `merge_queue` Ruleset (queue)

Two orthogonal layers, both config-as-code. A repo admin may apply both with
`bash infra/github/setup-main-branch.sh [<owner>/<repo>]`; the deployed operator can reconcile the
queue-only layer through `POST /api/v1/nodes/{id}/reconcile-merge-queue`:

- **Required-status-checks → classic branch protection.** Stay on classic protection for the checks set. Rulesets give no additional flexibility for the _event-specific required-checks-list_ problem (the falsified hypothesis below) — so there is no reason to migrate the checks. The fixture is `infra/github/branch-protection.json` → `PUT /repos/{repo}/branches/main/protection`.
- **Queue requirement → a `merge_queue` ruleset.** The fixture is `infra/github/merge-queue-ruleset.json` → `POST`/`PUT /repos/{repo}/rulesets` (idempotent find-by-name).

**The queue toggle is no longer UI-only.** Classic protection's `PUT .../protection` silently drops `required_merge_queue` — but that is a limitation of the _classic protection endpoint_, not of GitHub. The **rulesets** API carries the queue: a `merge_queue` rule is REST-settable (the 2026-04-28 experiment below in fact enabled the queue via the rulesets API). So the queue is now applied programmatically alongside the checks; the manual Settings → Branches checkbox is retired. The ruleset carries _only_ the `merge_queue` rule (not the checks), so it does not re-open the rejected "rulesets for required-checks lists" path.

**Runtime convergence uses the App, not a standing developer admin token.** The reconcile route is
`node.manage_envs`-gated, resolves the target repository from the node catalog, reads the fixture from
the deployment parent's `main`, and delegates the write to the operator GitHub App. The adapter
rejects a fixture that changes `ALLGREEN`, adds a bypass actor, or carries anything other than the
single queue rule; it reads the live ruleset back and fails unless every asserted field matches.
Required checks remain independent and untouched. This makes config drift repairable by the same
operator authority that owns generated deploy-state PRs without giving an agent GitHub administration.

`min_entries_to_merge_wait_minutes: 0` removes only the idle batch timer. It does not bypass the
queue: every PR still enters one serialized merge group, is rebased on current `main`, and must report
the required checks on that rebased tree. Generated environment PRs need this serialization while
they still commit shared per-environment AppSet and scheduler maps.

> Migration note: a repo that previously had the queue enabled via the classic UI checkbox should keep the ruleset as the single source of truth — the ruleset is authoritative and the legacy checkbox can be cleared once the ruleset is confirmed live (`gh api repos/{repo}/rulesets`).

## GitLab vFuture Mapping

GitLab's Merge Trains is the equivalent vendor primitive. The `REPORT_OR_DON'T_REQUIRE` invariant survives migration verbatim — the syntax changes, the policy doesn't.

| GitHub concept                            | GitLab equivalent                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| Branch (`main`)                           | Protected branch (`main`)                                                    |
| Classic branch protection required-checks | "Pipelines must succeed before merge" + per-job `rules:` in `.gitlab-ci.yml` |
| Merge Queue                               | **Merge Trains**                                                             |
| `merge_group:` workflow trigger           | `rules: - if: $CI_PIPELINE_SOURCE == "merge_train"` per-job                  |
| `pull_request:` workflow trigger          | `rules: - if: $CI_PIPELINE_SOURCE == "merge_request_event"` per-job          |
| `setup-main-branch.sh`                    | Project Settings API + per-job rules in `.gitlab-ci.yml`                     |

The GitLab-native shape of the policy:

```yaml
# .gitlab-ci.yml
unit:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
    - if: $CI_PIPELINE_SOURCE == "merge_train"
  script: pnpm test:ci

# Stub-job equivalent for PR-only intent (the GitLab analog of STUB_JOB_FOR_PR_INTENT).
title-validate:
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
      when: on_success
    - if: $CI_PIPELINE_SOURCE == "merge_train"
      when: on_success
  script:
    - if [ "$CI_PIPELINE_SOURCE" = "merge_train" ]; then echo "validated at MR-time"; exit 0; fi
    - validate-conventional-commit-title.sh "$CI_MERGE_REQUEST_TITLE"
```

Tier 1 enforcement in GitLab is "the MR pipeline must succeed end-to-end" (project Setting → "Pipelines must succeed before merge"). There is no per-context required-checks list — every job in the MR pipeline must succeed. This is actually cleaner than GitHub's per-context model: the same YAML drives both the gate and the artifact.

The portability boundary stays clean: workflow YAML changes (per-trigger → per-job rules), policy survives.

## Acceptance Checks

**Automated:**

- `pnpm check:docs` validates this spec's frontmatter and links.
- `setup-main-branch.sh` is idempotent (re-running does not change live state).

**Manual:**

1. After applying via `setup-main-branch.sh`: verify `gh api .../branches/main/protection | jq '.required_status_checks.contexts'` returns the four canonical checks.
2. Verify the queue ruleset is live: `gh api repos/{repo}/rulesets --jq '.[] | select(.name=="main-merge-queue") | .enforcement'` returns `active` (the script also confirms via GraphQL `mergeQueue`). Then open a no-op docs PR; click "Merge when ready"; queue accepts as soon as the four checks report on the merge-group ref, with no additional batch wait.
3. Drift detection: re-run the diff in `infra/github/README.md` against live; should be empty.

## Related

- [Repo Setup Fixture](./node-ci-cd-contract.md#repo-setup-fixture) — where this spec is referenced from the parent CI/CD contract.
- [Agentic Contribution Loop](./development-lifecycle.md) — Step 8 (request merge) + invariants `MERGE_QUEUE_DETERMINISM`, `NO_AGENTIC_REBASE`.
- [task.0391.enable-merge-queue.md](../../work/items/task.0391.enable-merge-queue.md) — original merge-queue adoption rationale.
- [GitHub Merge Queue docs](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) — authoritative on queue + status-check semantics.
- [GitLab Merge Trains](https://docs.gitlab.com/ee/ci/pipelines/merge_trains.html) — vFuture target.
