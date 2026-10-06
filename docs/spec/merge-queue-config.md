---
id: spec.merge-queue-config
type: spec
title: Merge Queue Required Checks — Policy & Empirical Constraints
status: active
trust: reviewed
summary: Required-status-checks policy for the merge queue, including the unified signed operator-change fast path. GitHub's queue waits forever for required checks whose workflows lack a `merge_group:` trigger — verified empirically.
read_when: Adding/removing a required status check; changing operator-generated environment PRs; debugging a stuck merge queue; setting up `main`-branch protection on a Cogni-DAO node fork; planning the GitLab vFuture port.
implements: []
owner: cogni-dev
created: 2026-04-28
verified: 2026-09-18
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
- Replacing the merge queue for ordinary code or human-authored PRs. Only the narrow, signed
  `cogni.operator-change.v1` envelope may direct-merge internally after its operation proof passes.

## Core Invariants

1. **REPORT_OR_DON'T_REQUIRE**: A required status check MUST be produced by a workflow that fires on both `pull_request:` AND `merge_group:` events. PR-only workflows cannot be required — the queue would wait forever for a status that never arrives. Empirically validated.
2. **QUEUE_GATE_IS_TREE_CORRECTNESS**: Normal code PRs use the image-build aggregator (`manifest`) plus `static`, `unit`, and `component`. A verified and enabled `cogni.operator-change.v1` PR changes no runtime image, so the same required context names report success after the operation-specific generator proof defined below.
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
rejects a fixture that changes `ALLGREEN`, adds a git-authored bypass actor, or carries anything
other than the single queue rule. It then injects the executing review App as the sole
installation-specific bypass actor, reads the live ruleset back, and fails unless every asserted
field matches.
Required checks remain independent and untouched. This makes config drift repairable by the same
operator authority that owns generated deploy-state PRs without giving an agent GitHub administration.

`min_entries_to_merge_wait_minutes: 0` removes only the idle batch timer for ordinary PRs. They still
enter a serialized merge group, rebase on current `main`, and report the required checks there.
The review App's ruleset bypass is not caller authority: `/vcs/merge` never requests it. A verified
`check_run` delivery only wakes the internal generated-change handler; no check name, conclusion, or
producer grants authority. The handler independently re-fetches and reclassifies the exact head,
then may request bypass after all required checks are green, bound atomically to that head SHA.

## Signed operator-change fast path

There is one generated-change protocol, not a new classifier and workflow condition for every
operator verb. The GitHub App writes this envelope:

```text
Cogni-Change-Type: cogni.operator-change.v1
Cogni-Operation: env.membership|env.placement|env.region|node.register|deployment.declare
Cogni-Node: <slug>
Cogni-Base-SHA: <40-hex main SHA and sole commit parent>
<operation-specific trailers>
Cogni-Changed-Paths-SHA256: <sha256 of sorted unique paths, one path per line>
```

`scripts/ci/operator-change-v1.allowlist.json` is the one versioned registry. It binds the exact
production/test App identities, the five operation names, their trusted replay verifier, and the
repositories where each operation is enabled. `enabledRepositories` is empty for every operation
until its positive and negative matrix passes in test-org.
`childRepositoryApps` authenticates the App signer for not-yet-minted repository names only; it
never enables an operation. Only `deployment.declare` may use it, after the protected base
`.cogni/repo-spec.yaml` binds `intent.name` exactly to both the target repository name and signed
node trailer. Its separate `enabledChildOwners` scope is also deployment-only and empty by default;
it avoids a per-child policy redeploy while granting no authority until explicitly enabled. The
operator still requires the parent's exact catalog `source_repo` binding for the resolved repo.

`scripts/ci/classify-operator-change-fast-path.sh` fails closed unless all of these are true:

- the workflow executes the classifier from trusted policy, never the PR-controlled copy: parent CI
  reads `origin/main`, while child repos call `.github/workflows/operator-change-verify.yml` pinned to
  an exact reviewed SHA; the reusable workflow derives its policy repository and revision only from
  `job.workflow_repository` and `job.workflow_sha`, not caller inputs;
- the PR and commit author match the exact repository-scoped GitHub App identity:
  `cogni-operator[bot]` for `Cogni-DAO/cogni`, or `cogni-operator-test[bot]` for the
  production-shaped `cogni-test-org/cogni-monorepo` E2E ground; no other repository inherits trust;
- GitHub reports the head commit signature as verified and valid;
- the same-repository branch, signed trailers, and PR head SHA agree;
- the operation is listed and its branch, subject, required trailers, base, head, and sole parent agree;
- the signed path hash equals GitHub's unique PR file list;
- the operation is enabled for this exact repository; and
- the operation's verifier, loaded from `origin/main`, replays the complete tree change exactly.

The reusable workflow's zero-install verifier is the checked-in
`scripts/ci/dist/operator-change-replay.cjs` bundle. Its source of record is the shared TypeScript
replay core used by the deployed operator, not the generated file. The first artifact was built by
the repository's trusted GitHub CI from PR #2581 head
`868781b69402506252aedabd07a1a8a39ae28882` (run `37440429053`, artifact `11400568283`,
SHA-256 `66d8661d1a0302a3f85c91b3665b8e6e34a14538f68b2329eda581a8b2a64169`). Full CI
permanently rebuilds it from source with the pinned workspace toolchain and requires byte-for-byte
identity before accepting a change. The generated bundle therefore carries no independently edited
policy, and stale generated bytes fail the same required CI that reviews their source.

The CI shell is transport only: it re-fetches the PR, commit, and complete file list, then passes
those normalized facts to that pinned bundle. The bundle executes the exact
`classifyOperatorChangeForMerge` policy used by the deployed operator and invokes the shared replay
core before it can emit `eligible=true`; shell drift cannot create a second eligibility policy.
For `deployment.declare`, verifier code and the registry remain pinned to
`job.workflow_repository@job.workflow_sha`, while the reusable workflow separately checks out that
same repository's current protected `main` catalog. The shared replay requires the exact
`infra/catalog/<node>.yaml` `source_repo` to equal the child PR repository. The control repository
must therefore be publicly readable to child CI; private-parent attestation is not part of v1.

Eligible PRs run only `resolve` and the trusted classifier. `static`, `unit`, and `component` are
GitHub `skipped` (a satisfied required conclusion) without scheduling those runners; `detect` is
also skipped, so its dependent `build` and `manifest` jobs skip as well. The trusted classifier job
owns the operation replay proof. A PR that does not claim the reserved type, or a valid operation
that is still disabled, runs full CI. A malformed reserved claim is red.
Titles, labels, branch names, or copied PR bodies alone grant nothing.

No caller receives bypass authority. `/api/v1/vcs/merge` always uses the ordinary developer/RBAC +
merge-queue path. The HMAC-verified internal `check_run.completed` handler treats the event only as
a retry signal. `VcsCapability.verifyOperatorChange` then re-reads the PR, commit, file list, current
base, and the configured parent repository's main-owned registry; re-checks exact App identity,
signature, one-commit history, envelope, path hash, exact repository enablement, and the built-in
operation replay; and only then reads required checks and submits GitHub's
separate generated-change capability with both `expectedBaseSha` and `expectedHeadSha`. That
capability re-fetches the open same-repository `main` PR and its exact one-parent commit, then moves
`heads/main` to that head through GitHub's non-force ref update (`force:false`). This is the atomic
base+head compare-and-swap: if another PR advances main, the now-divergent update is rejected with
409/422 and the stale PR remains unmerged. GitHub records this direct-push reachability as an
indirect PR merge; test-org proof must still assert `mergedAt` before production eligibility.
[Git ref update](https://docs.github.com/en/rest/git/refs) ·
[Indirect PR merges](https://docs.github.com/en/pull-requests/reference/pull-request-merges).
A stale head or base, unlisted repository, disabled or unimplemented replay, edit, or human PR
no-ops into the normal queue. Ordinary `mergePr` remains queue-backed, and queue-discovery failure
returns a structured failure rather than falling through to a direct App merge.
Human review holds remain authoritative metadata even when the signed commit is unchanged: a draft
PR is rejected by CI classification, operator reclassification, and the final CAS precondition; a
fresh `CHANGES_REQUESTED` review decision stops the facade before the ref update. Review history
that exceeds the first 100-result API page also stops the facade rather than risking a missed hold.
Required-check policy preserves GitHub's producer binding: classic `checks[].app_id` and ruleset
`integration_id` must match the reporting check-run App ID. A same-name check from another App
cannot satisfy the gate, and legacy commit statuses satisfy only a policy entry with no producer
binding. Check-run, legacy-status, and active-rule responses that indicate another page or a
truncated total fail closed; page-one success cannot hide later conflicting evidence or policy.
The webhook route also re-dispatches an already verified `check_run` wake if unrelated attribution
ingestion fails first. A retry after an ambiguous dispatch failure is safe because every attempt
reclassifies fresh state and uses the same non-force base/head compare-and-swap.

> Migration note: a repo that previously had the queue enabled via the classic UI checkbox should keep the ruleset as the single source of truth — the ruleset is authoritative and the legacy checkbox can be cleared once the ruleset is confirmed live (`gh api repos/{repo}/rulesets`).

The operation-specific fields are: membership (`Environment`, `Action`, `Lease-Generation`), placement
(`Environment`, `Provider`), region (`Environment`, canonical `Countries`,
`Lease-Generation`), registration (`Node-Id`, `Source-Repo`, `Source-SHA`, `Owner-Wallet`), and
deployment declaration (the common fields only). `node.register` omits executable runtime source;
its declarative formation footprint is rebuilt byte-for-byte from the shared writer plan.
`deployment.declare` also remains disabled until node-template ships the trusted child-main
classifier/identity contract. Its reusable CI verifier and operator service both call the same
canonical replay core, which consumes the stock declaration from
`packages/repo-spec/src/node-app-deployment-v1.json`. The operator additionally binds the exact
webhook repository to `infra/catalog/<node>.yaml` `source_repo` on the trusted parent before replaying
the single stock `.cogni/repo-spec.yaml` splice. No organization wildcard is accepted. Child
eligibility remains empty until task.5187 supplies the thin pinned caller and a fleet-specific
node-repository policy whose sole bypass actor is the exact fleet App; the current child policy's
`bypass_actors: []` correctly blocks the CAS write and cannot be weakened in this parent PR.

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
