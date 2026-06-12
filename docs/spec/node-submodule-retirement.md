---
id: spec.node-submodule-retirement
type: spec
title: Retire the Node Submodule Gitlink
status: draft
trust: draft
summary: Operator never checks out node source; node files reach the operator only by authenticated API fetch at an exact sourceSha. Removes .gitmodules, every nodes/<slug> gitlink, pin PRs, and all classifier special-casing.
read_when: Touching node formation, candidate-flight/promote deploy plane, single-node-scope, or any operator code that reads nodes/<slug>/ source
implements: []
supersedes_sections:
  - node-ci-cd-contract.md "Operator-hosted artifacts" (submodule paragraphs)
  - node-ci-cd-contract.md "Public + private node repos"
  - node-ci-cd-contract.md "SUBMODULE_GITLINK_IS_OPERATOR_PIN"
owner: cogni-dev
created: 2026-06-12
verified: null
tags:
  - ci-cd
  - node-formation
  - deployment
---

# Retire the Node Submodule Gitlink

## Context

Nodes evolved in-repo → standalone repos (the dev-experience win). The `nodes/<slug>`
**git submodule gitlink** is the leftover connective tissue from that migration. It is
the only thing that lets operator CI/CD reach across into node _source_ — and that reach
is exactly what breaks for private nodes and what the sovereignty model already forbids
("discovery is metadata-driven, not filesystem-driven").

Every private-node failure observed is an operator-side submodule clone:

- **Deploy (bug.5014):** `candidate-flight.yml` (×3) + `promote-and-deploy.yml` (×1) run
  `git submodule update --init` against the node repo.
- **Unit gate (main-red 2026-06-12):** `render-scheduler-worker-endpoints.sh` runs an
  _anonymous_ `git submodule update --init` to read the node repo-spec. It silently
  succeeds for public nodes and hard-fails for private ones, turning the operator's own
  secret-free unit gate red — cross-node coupling the model is supposed to make impossible.

The gitlink is redundant with records the operator already keeps. It carries two things,
both relocatable:

| Gitlink job today                                                                                                                    | Relocates to                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Operator reads node files (`k8s/` base + external-secrets) at deploy                                                                 | **`actions/checkout` of `source_repo` at `source_sha`** with the App token (`repository:` + `ref:` + `token:` + `path:`) — the OSS-native cross-repo checkout, private-safe by construction                                         |
| Operator reads node `repo-spec` to verify the `node_id` projection in the secret-free unit gate                                      | **Eliminated.** The projection is written by the operator at formation from the repo-spec it fetched over the API → catalog `node_id` == repo-spec `node_id` **by construction**; `node_id` is immutable. The unit gate trusts it   |
| The deploy `sourceSha` record + affected-flight trigger (`detect-remote-source-artifact-targets.sh` reads `git ls-tree` mode 160000) | **A `source_sha` field on the catalog row.** Detect reads `.source_sha` from YAML; a catalog `source_sha` change is the affected-flight trigger. The operator writes the field (formation + flight) where it used to bump a gitlink |

## Outcome

Success is when a node maintainer can keep their repo public **or flip it private** and the
operator builds, flights, and promotes it with **zero submodule checkout and zero pin PRs** —
node source reaches the operator only by authenticated API fetch at an exact `sourceSha`, and
the secret-free unit gate never touches node source at all.

## Non-Goals

- The artifact contract is unchanged: `source_repo + sourceSha + image_repository + digest`
  remain the deploy coordinates.
- Node dev experience is unchanged (already standalone repos).
- No public/private credential matrix: there is no separate "private node" code path. There is
  one path — authenticated API fetch — and it is identical for public and private nodes.

## Invariants

1. **OPERATOR_NEVER_CLONES_NODE_SOURCE** — no `git submodule` command, no `nodes/<slug>` gitlink,
   no `.gitmodules` anywhere in the operator repo or its workflows/scripts.
2. **NODE_SOURCE_BY_SOURCESHA_OVER_API** — any node file the operator genuinely needs is fetched
   from `source_repo` at an exact `sourceSha` over the GitHub API using the operator App
   installation token (CD jobs that hold secrets). Public and private nodes use the same call.
3. **SECRET_FREE_CI_IS_METADATA_ONLY** — the unit/static gate (no secrets, `FORK_FREEDOM`) reads
   **only** catalog metadata. It never reads, fetches, or clones node source. The catalog
   `node_id` projection is trusted: it is written at formation from the fetched repo-spec and
   `node_id` is immutable, so catalog == repo-spec by construction. No runtime drift check.
4. **CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN** — the accepted `source_sha` for a remote-source node is
   a field on its catalog row (`infra/catalog/<slug>.yaml`), not a gitlink. Affected-flight
   detection and `sourceSha` resolution read that field; the operator writes it. Candidate flight
   still accepts an explicit `nodeRef{sourceSha}` request; preview/prod promotion preserves the
   candidate-proven digest (`BUILD_ONCE_PROMOTE_DIGEST`).

## Target Design

### 1. Node-source access at deploy: OSS cross-repo checkout by sourceSha

CD jobs that need the node's `k8s/base/**` + `k8s/external-secrets/<env>/**` use **`actions/checkout`**
(`repository: <source_repo>`, `ref: <source_sha>`, `token: <app-token | GIT_READ_TOKEN>`, `path: node-src`),
then copy the needed paths into the deploy branch. This replaces the `submodule update --init` +
`rsync app-src/nodes/<node>/k8s/**` pair in **candidate-flight.yml** (×3) and **promote-and-deploy.yml**.
No bespoke fetch script; identical for public/private.

### 2. Secret-free CI: metadata-only, no drift check

`render-scheduler-worker-endpoints.sh` stops cloning the submodule and stops cross-checking the
repo-spec. It renders scheduler routing from the catalog `node_id` projection alone (already the SSOT
`image-tags.sh` uses). The runtime catalog↔repo-spec drift check is **deleted** — the projection is
correct by construction (Invariant 3). `catalog-identity-ssot.spec.ts` and `single-node-scope-meta.spec.ts`
stop reading `.gitmodules`; an "external node" is the catalog row carrying `source_repo` (no gitlink).

### 3. Deploy pin: catalog `source_sha`, not the gitlink

Add `source_sha` to the remote-source catalog row schema. `detect-remote-source-artifact-targets.sh`
reads `.source_sha` from the catalog instead of `git ls-tree … 160000`; `path_selects_target` already
fires on `infra/catalog/<slug>.yaml` changes, so a `source_sha` bump is the affected-flight trigger.
`promote-and-deploy.yml` drops its gitlink-mode resolution (L299) and `submodule update --init` (L476);
promotion preserves the candidate-proven digest.

### 4. Node formation: catalog + footprint, no gitlink, no pin PR

`openNodeSubmodulePr` stops writing the `160000` gitlink and the `.gitmodules` blob; it writes only
the operator-owned footprint (catalog row with `source_repo` + `source_sha` + `node_id` projection,
overlays, AppSets, Caddy, scheduler endpoint). `ensureNodeSubmodulePin` and the pin-PR machinery are
deleted outright — flight is purely API-addressed (`nodeRef{nodeId, sourceSha}`); the operator validates
the child commit + repo-spec identity over the API (already done in `prepareNodeRefCandidateFlight`) and
writes the catalog `source_sha` instead of pinning a gitlink. `renderGitmodules` + its gens/test are
deleted.

### 5. Classifiers: a `source_repo` row is operator-domain, period

`classify.ts` keeps the existing behavior that a bare `nodes/<slug>` path is operator-domain — but
that path no longer exists in-tree, so the relevant rows are the catalog/overlay/appset files, which
are already operator-domain. `render-scope-filters.sh` drops its `.gitmodules` exclusion (no
submodule slugs exist). Fixture `19-submodule-gitlink-operator-pin.json` is deleted (no gitlinks to
classify).

## Deletion Inventory

**Delete entirely:** `nodes/operator/app/src/shared/node-app-scaffold/gens/gitmodules.ts` (+ test +
barrel export), `GitHubRepoWriter.ensureNodeSubmodulePin` + `treePinsNodeSubmodule` + pin-PR helpers

- their tests, `tests/ci-invariants/fixtures/single-node-scope/19-submodule-gitlink-operator-pin.json`,
  all `git submodule update --init` steps, the `.gitmodules` blob writes, every `nodes/<slug>` gitlink
- the `.gitmodules` file.

**Rewrite to metadata/API:** `candidate-flight.yml`, `promote-and-deploy.yml`,
`render-scheduler-worker-endpoints.sh`, `detect-remote-source-artifact-targets.sh`,
`catalog-identity-ssot.spec.ts`, `single-node-scope-meta.spec.ts`, `render-scope-filters.sh`,
`classify.ts` comments, `openNodeSubmodulePr`, `buildFootprintEntries`, publish route + tests,
`check-migrations-immutable.mjs` (`isCurrentGitlink` → no node gitlinks), `check-root-layout.ts`
(drop `.gitmodules` from allowed root), `launch-pack.ts` wording, scheduler-routing test fixtures.

**Docs to update:** `node-ci-cd-contract.md` (rewrite the submodule sections to this model),
`node-baas-architecture.md`, `repo-sync-contract.md`, `ci-cd.md`, `multi-node-dev.md`,
`github-app-webhook-setup.md`, `legacy-cicd-to-remove.md`.

## Acceptance Checks

1. `grep -rn "git submodule\|\.gitmodules\|160000" .github/ scripts/ nodes/operator` returns nothing
   load-bearing (only incidental/historical).
2. `.gitmodules` does not exist; no `nodes/<slug>` gitlink entries in the tree.
3. A **private** node flights to candidate-a green (image resolve + deploy + `/version.buildSha`),
   with no submodule step in the run.
4. Main unit gate is green with a **private** node present in `infra/catalog/` (no node-source read).
5. Preview/prod promotion preserves the candidate-proven digest with no gitlink read.
6. Node formation produces no pin PR; the single operator footprint PR still passes single-node-scope.

## Related

- [node-ci-cd-contract.md](./node-ci-cd-contract.md) — artifact contract (unchanged) + sections this supersedes
- bug.5014 — candidate-flight private submodule clone (subsumed by this)
