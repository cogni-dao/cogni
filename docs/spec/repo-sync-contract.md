---
id: spec.repo-sync-contract
type: spec
title: Multi-Repo Sync Contract
status: draft
trust: draft
summary: Topology, scope manifest, and sync mechanism for keeping operator-scope content aligned across the cogni monorepo (hub), node-template, and per-node forks (cogni-poly).
read_when: Editing operator-scope content (scripts/ci, infra/k8s/base, .github/workflows, scripts/setup, infra/compose, infra/catalog), labeling a PR `needs-upstream-sync`, or deciding which repo a fix belongs in.
implements:
  - proj.repo-sync
owner: derekg1729
created: 2026-05-26
verified: 2026-05-26
tags:
  - ci-cd
  - deployment
  - meta
---

# Multi-Repo Sync Contract

## Context

Cogni's deployment artifacts span three git repos today:

- `Cogni-DAO/cogni` — the **monorepo hub**. Holds `nodes/operator/`, `nodes/node-template/`, `nodes/resy/`, plus the canonical `scripts/ci/`, `infra/k8s/base/`, `.github/workflows/`, `infra/compose/`, `infra/catalog/`.
- `Cogni-DAO/node-template` — the **OSS template artifact**. Public surface for forks. Mirrors the hub's `nodes/node-template/` 1:1 and inherits operator-scope infrastructure.
- `Cogni-DAO/cogni-poly` — a **per-node fork artifact**. Polymarket-specific node that historically branched off node-template; continues to land operator-scope CI/infra fixes that the hub needs.

Operator-scope fixes have been diverging across these three repos with no shared lineage. Empirical evidence and the backlog of unsynced PRs are tracked in [proj.repo-sync](../../work/projects/proj.repo-sync.md). The canonical example: `scripts/ci/wait-for-in-cluster-services.sh` is byte-identical-stale between hub and node-template, while cogni-poly already eliminated the divergence in [#127](https://github.com/Cogni-DAO/cogni-poly/pull/127). bug.5001 is the same anti-pattern repeated.

This spec defines the invariants. The project owns the roadmap.

## Goal

Define the contract that:

1. Names a single hub for operator-scope content (cogni monorepo).
2. Declares operator-scope paths in a machine-readable manifest committed to every repo.
3. Specifies how drift is surfaced (mechanism is project-owned; the spec asserts the contract the mechanism must satisfy).
4. Requires the hub to ship multi-node fundamentals so downstream artifacts inherit them rather than re-implementing.

## Non-Goals

- The drift-detector workflow itself (project-owned, see [proj.repo-sync](../../work/projects/proj.repo-sync.md) slice S2).
- Backlog drain — project-owned (slice S3).
- Migrating cogni-poly's content into the monorepo (separate question; the contract works either way).
- Touching the artifact repos in this PR (separate coordination).
- Per-node review policy or CI invariants — see [spec.node-ci-cd-contract](./node-ci-cd-contract.md).

---

## Core Invariants

1. **HUB_IS_COGNI_MONOREPO**: `Cogni-DAO/cogni` is the canonical hub for all operator-scope content. Fixes land in the hub first; artifacts pull. Direct edits to operator-scope paths in `node-template` or `cogni-poly` are tolerated but the contract requires they round-trip through a hub PR within one sync cycle.

2. **MANIFEST_IS_SSOT**: `.cogni/sync-manifest.yaml` (in each repo, kept identical via the same sync mechanism) is the single declaration of which paths are operator-scope. No path is in scope unless declared. Adding a path to scope is itself a hub PR.

3. **MANIFEST_BOOTSTRAP**: The manifest is itself an operator-scope path and propagates by the same mechanism as any other in-scope file. Schema changes (i.e., changes to `.cogni/sync-manifest.yaml`'s structure) MUST land hub → artifacts in lock-step: the hub PR that changes the schema MUST also patch the validators in each artifact. At v1, the hub PR's drift-detector run reports red until the artifact PRs land, and reviewers enforce the lock-step ordering — hard-blocking via cross-repo required check is a v1.1 follow-up (same pragmatism as Backflow). Initial bootstrap of `.cogni/sync-manifest.yaml` into each repo is a one-time manual PR per repo (project slice S1) — after which the manifest sustains its own propagation.

4. **DECLARED_DIVERGENCE**: Any intentional divergence between a hub path and its artifact counterpart MUST appear in the manifest's `divergences:` block with a `reason:` field. Undeclared divergence is a contract violation surfaced by the drift detector.

5. **MULTI_NODE_OUT_OF_BOX**: The hub MUST ship multi-node fundamentals (catalog-driven Caddyfile, catalog-driven `deploy-infra.sh` per-node env vars, catalog-driven CI gating). node-template inherits these and ships them in fork-quickstart even though it ships with one node today. Single-node hardcoding in operator-scope paths is a contract violation regardless of which repo it lives in.

6. **ONE_FIX_ONE_LINEAGE**: A fix that addresses the same root cause as an existing upstream PR MUST cite the upstream PR in its description and be cherry-picked or rebased onto upstream's commit, not re-implemented. Reviewers reject parallel fixes with no shared lineage.

7. **CATALOG_BOUNDARY**: `infra/catalog/*.yaml` is the API between operator-scope and per-node scope. Operator-scope code reads from the catalog and never special-cases node names. Per-node bits (a node's own `nodes/<name>/`) are downstream-only and do not propagate up — with the sole exception of `nodes/node-template/`, which IS the canonical template node and propagates hub → node-template-artifact 1:1.

---

## Topology

```
                              Cogni-DAO/cogni  (HUB)
                              ├── nodes/operator/         (operator app, hub-only)
                              ├── nodes/node-template/    (template node — exported to node-template-artifact)
                              ├── nodes/resy/             (per-node, hub-only)
                              ├── scripts/ci/             (operator-scope)
                              ├── scripts/setup/          (operator-scope)
                              ├── infra/k8s/base/         (operator-scope)
                              ├── infra/k8s/argocd/       (operator-scope)
                              ├── infra/k8s/secrets/      (operator-scope)
                              ├── infra/compose/          (operator-scope)
                              ├── infra/catalog/          (operator-scope; API boundary)
                              ├── .github/workflows/      (operator-scope)
                              └── .cogni/sync-manifest.yaml  (SSOT of what is in scope)
                                       │
                          ┌────────────┴────────────┐
                          ▼                          ▼
                Cogni-DAO/node-template       Cogni-DAO/cogni-poly
                (OSS template artifact)       (per-node fork artifact)
                ├── nodes/node-template/      ├── nodes/poly/         (fork-owned, not hub-mirrored)
                │   (mirrors hub 1:1)         └── operator-scope paths (hub-mirrored)
                └── operator-scope paths
                    (hub-mirrored)
```

**Primary flow:** hub → artifacts (forward sync).
**Edge-case flow:** artifact → hub → artifacts (backflow, when a fix lands in cogni-poly first; must round-trip through hub).

`nodes/poly/` exists in cogni-poly but not in the hub; it is fork-owned content outside the contract. If the monorepo adopts poly as a hub-side node in the future, that becomes a hub-mirrored relationship, requiring a manifest entry.

---

## Operator-Scope Manifest (inverse form, schema 2)

**Location:** `.cogni/sync-manifest.yaml` at repo root.
**Contract:** `.cogni/sync-manifest.schema.json` (JSON Schema 2020-12, enforced in CI via `check-jsonschema`).
**Cross-reference checks:** `scripts/validate-sync-manifest-refs.mjs` (wired into `pnpm check:docs`).

**Shape.** Everything under the hub is shared by default. The manifest enumerates only:

1. `exclude[]` — global caches/junk that nothing cares about (`.git/**`, `node_modules/**`, etc.)
2. `divergences[]` — one entry per artifact with:
   - `omit_from_artifact[]` — paths the hub has that THIS artifact intentionally lacks
   - `artifact_only[]` — paths THIS artifact has that the hub intentionally lacks

Anything not covered by `exclude` or the artifact's divergence MUST mirror 1:1. The detector treats any file outside those lists with a hash mismatch as **drift**.

This is the inverse of the v1 (schema=1) form, which enumerated `scope[]` of included paths. Inversion makes "I added a new operator-scope dir but forgot to update the manifest" an impossible class of bug.

See the live file for current content. The schema is the durable contract; if doc and live drift, the schema wins.

---

## Sync Mechanism

### v1 — Manifest + Drift-Detector Workflow (ships in this PR)

**As-built.** `.github/workflows/sync-drift-detector.yml` runs `scripts/ci/detect-sync-drift.mjs` on a daily schedule, on push:main when the manifest or detector itself changes, and on `workflow_dispatch`. The detector clones each declared `public` artifact at HEAD, walks every hub file not covered by `exclude` or the artifact's `omit_from_artifact`, sha256-diffs each, then classifies drift into:

- 🟡 **different** — same path on both, content mismatch.
- 🔴 **missing-on-artifact** — hub has it, artifact doesn't, divergence does not declare the omission.
- 🟣 **only-on-artifact** — artifact has it, hub doesn't, divergence does not declare the addition (backflow candidate).

The workflow upserts a tracking issue on the hub labeled `sync-drift` with the markdown report as the body. Issue title carries the count; body uses collapsible `<details>` per drift class. Existing open issue is updated in place (idempotent). Zero drift + no existing issue = no-op.

**Permissions.** `contents: read` + `issues: write` on the hub. No PAT, no GitHub App — the default `GITHUB_TOKEN` is sufficient for v0.1 because:

- Public artifacts (`Cogni-DAO/node-template`) are cloned anonymously.
- Private artifacts (`Cogni-DAO/cogni-poly`) are skipped with an explicit `⏭️ skipped — visibility=private` line in the report. v0.2 plumbing for a PAT or GitHub App is a separate slice.
- The detector does NOT open PRs on artifact repos. It only surfaces drift on the hub as an issue. Auto-PR-on-artifact is v0.2.

**OSS-first survey.** Existing tools considered and rejected:

- `repo-file-sync-action`, Renovate regex managers, `copier` — all do hub → artifact file propagation but none model `omit_from_artifact` + `artifact_only` together (the two-direction divergence the contract requires).
- `josh-proxy` is the v2 mechanism (see below).

**Acceptance test.** Running the detector against current main produces a non-empty drift list, and at least one entry is `.github/workflows/ci.yaml` differing between hub and node-template (that is the bug.5001 anti-pattern made visible). PR #1355 includes a recorded run as the closeout evidence.

### v0.2 / v1.1 — what's deliberately deferred

- **Cogni-poly coverage.** Needs a PAT or GitHub App installation to clone the private repo. Separate slice.
- **Auto-PR on artifact.** Detector currently surfaces drift as a hub issue only. Auto-PR-against-artifact needs write perms on the artifact repos (App install or PAT).
- **Backflow auto-PR-on-hub.** Same constraint.
- **Branch-protection enforcement** on artifact-side `needs-hub-lineage`. v1.1.

### v2 — Josh-Proxy as Shape A Catalog Service

**Approach.** Deploy [josh-proxy](https://josh-project.github.io/josh/) as a Shape A catalog service (validated via the [cogni-poly#128](https://github.com/Cogni-DAO/cogni-poly/pull/128) onboarding pattern). Define josh filters that expose operator-scope subdirectories of the cogni monorepo as virtual git repos. Artifacts (`node-template`, `cogni-poly`) become filtered views: clone, edit, push back through the proxy, and changes apply to the hub with history preserved bidirectionally.

**Why second, not first.**

- Requires the manifest from v1 (filters are derived from `scope:`).
- Requires hosting a daemon (small VM or in-cluster pod) — platform-grade infra.
- Filter authoring is a DSL; bus-factor risk.
- Self-bootstrapping fit: deploying josh via the catalog _is_ the contract test for "adding a service is easy."

**v2 entry criterion.** If v1 is sustainable and bidirectional friction is low, v2 may be deferred indefinitely. v2 ships only if the friction cost of manifest-driven PR review exceeds the infra cost of running josh.

---

## Drift Acceptance Rules

A divergence between hub and artifact falls into exactly one of:

| Class             | Definition                                                                             | Resolution                                                                                                                                                                                                                                                                    |
| ----------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Intentional**   | Path is in scope, but artifact MUST differ (e.g., node-template has no `release.yml`). | Declared in manifest `divergences:` with `reason:` field. Drift detector ignores.                                                                                                                                                                                             |
| **Pending**       | Hub has a change not yet synced to artifact.                                           | Drift detector opens auto-PR on artifact.                                                                                                                                                                                                                                     |
| **Backflow**      | Artifact has a change not yet round-tripped through hub.                               | Drift detector opens auto-PR on **hub** and flags the artifact PR with a "needs-hub-lineage" label so reviewers can require a hub PR reference before merge. (Hard-blocking via branch protection is a v1.1 follow-up; v1 ships with the flag + label, not a required check.) |
| **Unintentional** | Neither side knows the divergence exists.                                              | Drift detector opens both: an audit issue on hub + an auto-PR on whichever side is canonical-by-recency. Requires manual judgment.                                                                                                                                            |

A path is **never** in two classes. If it would be, the manifest is wrong and must be updated.

---

## Multi-Node-Readiness Load-Bearing Test

The contract's correctness is asserted by a single property: **node-template, with zero edits to operator-scope paths, must be able to host a fork that adds a second node.**

This property is currently red — the Caddyfile template and `deploy-infra.sh` per-node env-var block both hardcode single-node assumptions (bug.5001 lineage). Driving it green is a slice of [proj.repo-sync](../../work/projects/proj.repo-sync.md) and is a precondition for declaring the contract live.

The property is asserted by the CONTRACT_TEST below.

---

## CONTRACT_TEST

A repeatable validation that the contract holds end-to-end. **This test becomes load-bearing only after MULTI_NODE_OUT_OF_BOX is green** ([proj.repo-sync](../../work/projects/proj.repo-sync.md) slice S4). Before that, it documents the target state, not current state.

1. Fork `Cogni-DAO/node-template` to a fresh GitHub account.
2. Add a second node entry to `infra/catalog/` (per `infra/catalog/_schema.json`).
3. Add `nodes/<name>/` with the minimal Shape A service skeleton (reference: [cogni-poly#128](https://github.com/Cogni-DAO/cogni-poly/pull/128)).
4. Run the standard CI gates for the fork (catalog schema + workflow checks).
5. Push to the fork and observe a green build.

**Pass criterion:** zero edits to any operator-scope path (per the manifest `scope:` glob).
**Fail criterion:** any required edit outside of `nodes/<name>/` and `infra/catalog/<name>.yaml`.

---

## References

- [proj.repo-sync](../../work/projects/proj.repo-sync.md) — owns the roadmap, status, and backlog.
- [spec.node-ci-cd-contract](./node-ci-cd-contract.md) — CI invariants per node; this spec is the cross-repo complement.
- [spec.private-node-repo-contract](./private-node-repo-contract.md) — related artifact-vs-template framing.
- [cogni-poly#127](https://github.com/Cogni-DAO/cogni-poly/pull/127) — Exhibit A: catalog-driven CI fix that failed to upstream.
- [cogni-poly#128](https://github.com/Cogni-DAO/cogni-poly/pull/128) — Shape A onboarding validation; the pattern v2 would deploy josh through.
- [cogni#1348](https://github.com/Cogni-DAO/cogni/pull/1348) — parallel bug.5001 fix that motivated this spec.
- [josh-project](https://josh-project.github.io/josh/) — v2 mechanism candidate.
