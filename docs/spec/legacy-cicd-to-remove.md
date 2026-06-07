---
id: legacy-cicd-to-remove
type: spec
title: Legacy CI/CD To Remove
status: active
trust: draft
summary: Inventory of CI/CD mechanics that do not match the sourceSha artifact contract and must be removed once replacement paths are live.
read_when: Modifying candidate flight, preview promotion, production promotion, PR-build tags, or remote-source artifact deployment.
owner: derekg1729
created: 2026-06-07
verified: 2026-06-07
tags:
  - ci-cd
  - deployment
---

# Legacy CI/CD To Remove

## North Star

One artifact contract. One promotion primitive. Everything else is policy.

Deployable artifacts are promoted by artifact identity:

```text
source_repo + sourceSha + image_repository
  -> image_repository:sha-<sourceSha>
  -> { target, source_repo, sourceSha, image_repository, digest }
  -> deploy/<env>-<target>
  -> /version.buildSha == sourceSha
```

Anything that uses a pull request number, merge-queue tag, or preview tag as artifact identity is transitional. PR numbers remain review metadata only.

## Inventory

### PR-shaped image tags

**Mechanic:** `.github/workflows/pr-build.yml`, `scripts/ci/resolve-pr-build-images.sh`, and `flight-preview.yml` still use `pr-<prNumber>-<headSha>`, `mq-<prNumber>-<queueSha>`, and `preview-<sha>` for in-repo artifacts.

**Why it is legacy:** The deploy coordinate is not `source_repo + sourceSha + image_repository`; it is a PR-derived lookup namespace.

**Why not removed here:** Operator-owned in-repo artifacts still need this path until their catalog rows publish `source_repo` + `image_repository` and the source-SHA resolver covers them.

**Removal condition:** Every deployable catalog row has an artifact source repo and every source repo publishes `image_repository:sha-<sourceSha>`. Preview resolves all changed targets by source-SHA tags; no re-tagging step remains.

### Candidate PR-number dispatch

**Mechanic:** `candidate-flight.yml` still accepts `pr_number` and `head_sha` workflow inputs for transitional in-repo artifact flights.

**Why it is legacy:** `POST /api/v1/vcs/flight` no longer accepts PR-number deploy identity. The workflow input remains only because in-repo artifacts still have PR-shaped build outputs.

**Why not removed here:** Removing the workflow input before migrating operator-owned in-repo artifacts would strand the current control-plane candidate lane.

**Removal condition:** Candidate flight resolves all targets from source-SHA artifact tags, including operator-owned artifacts. Delete `pr_number`, `head_sha`, PR files API lookup, and PR status reporting from `candidate-flight.yml`.

### In-repo artifact build fan-out

**Mechanic:** `scripts/ci/detect-affected.sh` selects targets this repo must build from catalog path changes. Rows whose `source_repo` is another repo are skipped because their source repo owns the build.

**Why it is legacy:** Parent build fan-out is valid only for deployables whose source repo is still this repo. It must not become a second node model.

**Why not removed here:** `operator`, `resy`, `canary`, and scheduler-worker are not fully represented as source-SHA artifact rows yet.

**Removal condition:** Parent-owned deployables publish `source_repo` + `image_repository` rows and use the same `sha-<sourceSha>` resolver. `detect-affected.sh` remains a build-plane selector only; deploy selection consumes artifact records.

### Preview re-tagging

**Mechanic:** `flight-preview.yml` re-tags merge-queue images into `preview-<mainSha>` for parent-built targets.

**Why it is legacy:** Preview should carry the candidate-proven digest forward, not mint a new lookup tag.

**Why not removed here:** Parent-built in-repo artifacts still need a lookup path for `promote-and-deploy.yml`. Remote-source artifact rows now bypass this and resolve `image_repository:sha-<sourceSha>` directly.

**Removal condition:** `promote-and-deploy.yml` consumes a resolved digest payload or resolves every target from `image_repository:sha-<sourceSha>`; the `Re-tag merge_group images as preview-{sha}` step is deleted.

### Digest re-resolution instead of carry-forward

**Mechanic:** Remote-source artifact preview promotion can re-resolve `image_repository:sha-<sourceSha>` after merge rather than consuming the exact artifact record resolved during candidate flight.

**Why it is legacy:** A serious deploy plane resolves once, stores `{ target, source_repo, sourceSha, image_repository, digest }`, and carries that exact digest through candidate, preview, and production. Re-resolution is only equivalent if the source-SHA tag is immutable and never repointed.

**Why not removed here:** This PR is the first vertical slice for remote-source artifact rows. Adding a durable artifact-record store plus cross-workflow carry-forward would widen it into the platform rewrite.

**Removal condition:** Candidate flight writes a durable artifact record for each promoted target; preview and production read that record or a promoted successor record and never re-resolve source-SHA tags after the first accepted resolution.

### Gitlink as source-SHA pin

**Mechanic:** Remote-source artifact preview promotion infers `sourceSha` from the parent repo gitlink at `nodes/<slug>`.

**Why it is transitional:** Gitlinks are a good approval pin, but they are not the fundamental deployment primitive. The artifact coordinate is `source_repo + sourceSha + image_repository`.

**Why not removed here:** The current operator publish/pin PR flow uses gitlinks as the reviewable acceptance record.

**Removal condition:** The operator has an explicit, reviewable source pin record that carries `source_repo`, `sourceSha`, and artifact rows without requiring a submodule checkout shape.
