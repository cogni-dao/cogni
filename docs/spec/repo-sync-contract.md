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
verified: 2026-09-29
tags:
  - ci-cd
  - deployment
  - meta
---

# Multi-Repo Sync Contract

## Context

Cogni's deployment artifacts span three git repos today:

- `Cogni-DAO/cogni` — the **operator control-plane hub**. Holds `nodes/operator/`, submodule pins for hosted node repos, any remaining legacy in-tree node directories while they are being migrated, plus the canonical `scripts/ci/`, `infra/k8s/base/`, `.github/workflows/`, `infra/compose/`, `infra/catalog/`.
- `Cogni-DAO/node-template` — the **canonical node-at-root template**. Public source for named node forks. The hub may pin it as a submodule/deployment row, but does not mirror its source under `nodes/node-template/**`.
- `Cogni-DAO/cogni-poly` — a **per-node fork artifact**. Polymarket-specific node that historically branched off node-template; continues to land operator-scope CI/infra fixes that the hub needs.
- `cogni-test-org/cogni-monorepo` — the **test parent**. Not a downstream node: a near-1:1 mirror of the hub that candidate-a deploys FROM (the operator's `NODE_SUBMODULE_PARENT_{OWNER,REPO}` on candidate-a). See § Test-Parent Mirror.

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

5. **MULTI_NODE_OUT_OF_BOX**: The hub MUST ship multi-node fundamentals (catalog-driven Caddyfile, catalog-driven `deploy-infra.sh` per-node env vars, catalog-driven CI gating). node-template ports the relevant operator-hosted node contract without becoming an in-tree hub source directory. Single-node hardcoding in operator-scope paths is a contract violation regardless of which repo it lives in.

6. **ONE_FIX_ONE_LINEAGE**: A fix that addresses the same root cause as an existing upstream PR MUST cite the upstream PR in its description and be cherry-picked or rebased onto upstream's commit, not re-implemented. Reviewers reject parallel fixes with no shared lineage.

7. **CATALOG_BOUNDARY**: `infra/catalog/*.yaml` is the API between operator-scope and per-node scope. Operator-scope code reads from the catalog and never special-cases node names. Per-node source bits live in their source repo. A hub `nodes/<name>` gitlink is an operator pin, not source content.

8. **TEST_PARENT_IS_NEAR_IDENTICAL**: an artifact declaring `role: test-parent` mirrors hub main 1:1 for ALL CI/CD infrastructure. Exactly three kinds of difference may be declared — **test identity**, **fixture roster + source pins**, and **environment-specific desired state**. A test-specific reimplementation of a workflow, generator, script, Crossplane/Argo manifest or substrate module is a contract violation, not a divergence: the mirror's value is that it executes the SAME lane production does, and a reimplemented lane proves nothing about the real one.

9. **PRESENCE_IS_NOT_CONTENT**: roster-generated CONTENT is per-deployment; roster-generated PRESENCE is not. `content_may_differ:` suppresses the content check only, so a canonical path the hub generates can never be silently absent on an artifact. Content correctness stays with the canonical generators' own `--check` gates running in the artifact's own CI against the artifact's own catalog — one derivation per fact, never two readers.

10. **MISSING_MAY_BE_FATAL**: an artifact declaring `on_missing: fail` turns an undeclared missing-on-artifact path into a non-zero detector exit. Evidence for the rule: the mirror's absent `infra/k8s/overlays/<env>/scheduler-worker/node-endpoints.patch.yaml` surfaced only as a 422 (`cannot plan scheduler routing for '<env>'/'<slug>': missing the current node-endpoints patch`) at env-activation time, on the mirror, hours into a node launch — not as a red build on the hub that generated the path.

11. **REFRESH_IS_NOT_A_ROSTER_CHANGE**: a content refresh converges code, never membership. Retiring a node from the mirror (catalog row + ApplicationSet + body together) is its own reviewed change; the refresh declares such legacy bodies retained rather than deleting them as a side effect.

12. **SYNC_IS_A_REVIEWED_PR**: the refresh opens ONE pull request as the operator GitHub App, parented on the mirror's own `main` so it is conflict-free by construction. It never pushes or force-pushes `main`, and hub `production`/`staging` secret material is declared hub-only so it cannot enter the mirror's tree by construction rather than by convention.

13. **AUTOMATIC_FORK_SOURCE_SYNC_DOES_NOT_EXIST**: a `node-template` default-branch push MUST NOT create or update branches or PRs in child node repositories. The webhook has no fork-sync dispatcher, the deploy plane exposes no fork source-writing methods, and CI rejects reintroduction of the retired symbols/branches. This removal followed bug.5304, where the old template-authoritative overlay rewrote product paths in every active fork and deleted Poly's rendered copy-trading dashboard. Cross-repo delivery uses versioned packages, pinned reusable workflows, or rare fail-closed codemods; until a lane exists, changes are ordinary reviewed per-node PRs.

14. **OWNER_APP_BOUNDARY_FAILS_CLOSED**: every `role: test-parent` artifact declares the non-secret GitHub App ID + slug allowed to write its owner. The workflow mints with that manifest ID, masks decoded key material before workflow output, and verifies the returned App slug before any repository write. It never selects an App ID from a generic environment secret. A stale cross-environment keypair therefore fails authentication instead of widening authority or writing to the wrong org.

---

## Topology

```
                              Cogni-DAO/cogni  (HUB)
                              ├── nodes/operator/         (operator app, hub-only)
                              ├── nodes/node-template     (gitlink pin to Cogni-DAO/node-template)
                              ├── nodes/<legacy>/         (transitional in-tree node source, if any)
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
                Cogni-DAO/node-template          Cogni-DAO/cogni-poly
                (node-at-root template)        (per-node fork artifact)
                ├── app/                       ├── nodes/poly/         (fork-owned, not hub-mirrored)
                ├── graphs/                    └── operator-scope paths (hub-mirrored)
                ├── packages/
                └── operator-hosted node contract files
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

The manifest still carries the legacy top-level **`node_local:`** glob block for schema compatibility and historical fork ownership declarations. Automatic node-template→fork source sync is disabled, so no runtime writer consumes this block. `divergences[]` remains the active hub↔artifact drift-detector axis.

---

## Automatic Fork Source Sync (Disabled)

The hub↔artifact drift model above remains an active **detector** axis. Automatic
`node-template → spawned fork` source propagation is not active.

No runtime seam remains: webhook handling does not recognize template pushes as a distribution event,
the deploy-plane port has no fork source-writing verbs, and the GitHub adapter contains no implementation
capable of manufacturing a fleet PR.

### Incident evidence

The retired mechanism had two writing tiers: a force-overwrite closure for CI/identity files and a
catch-all template-authoritative overlay for everything not declared `node_local`. The overlay began
with each fork's tree, replaced every differing non-`node_local` blob with the template blob, and
parented the result on the fork tip. That made the result conflict-free by construction by suppressing
the very divergence signal that should have stopped the write.

In the 2026-09-27/28 sync wave, every active fork received product-path rewrites. Poly PR #32
(`d685fc8`) replaced its dashboard and deleted all rendered copy-trading surfaces one day after they
shipped. Beacon lost platform-connection UI; LevelUp and Toks5 lost fork-specific governance/profile
behavior; Toks4 also received product-path changes. This disproved both
`TIER2_NODE_TEMPLATE_AUTHORITATIVE` and `TIER2_IS_ALWAYS_MERGEABLE` as safe invariants.

### Current operating rule

- A template push creates **zero** fork source-sync branches and PRs.
- Retired writer names and their living branch names are forbidden by a structural CI guard.
- Cross-repo fixes use explicit, ordinary per-node PRs while package/workflow/migration distribution is
  built. Product ownership is never inferred from absence in an exception list.
- Compatibility is not source equality: a node's supported platform version and conformance behavior
  determine health. A divergent source tree that satisfies the contract is decoupled, not stale.

---

## Test-Parent Mirror

`cogni-test-org/cogni-monorepo` is where operator CI/CD is exercised before it reaches production: candidate-a's operator reads ITS catalog, opens node-formation PRs against IT, and renders env state from IT. That makes its staleness indistinguishable from a product bug — a node launch fails against a control plane that has not existed on main for months, and the failure is attributed to the launch.

**Two axes, one policy.** The declared divergence in `.cogni/sync-manifest.yaml` is read by exactly one compiled module (`scripts/ci/lib/sync-policy.mjs`) and consumed by both:

| Axis          | Mechanism                          | Output                                                                                              |
| ------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| **Surfacing** | `scripts/ci/detect-sync-drift.mjs` | ancestry + path drift → ONE upserted `sync-drift` hub issue; non-zero exit per MISSING_MAY_BE_FATAL |
| **Repair**    | `scripts/ci/sync-test-parent.mjs`  | ONE reviewed PR on the mirror, as the operator GitHub App                                           |

Both run on every push to hub `main` and on a daily schedule. "What drift reports" and "what sync does" cannot disagree, because neither owns a matching rule.

**Authority boundary.** The test-parent artifact binds `cogni-test-org` to the
`cogni-operator-test` App in the manifest. The GitHub Environment provides only the corresponding
private key; it cannot choose the App identity. The workflow masks the decoded PEM before it becomes
a step output and requires the minted App slug to match the manifest before running the repair.

**What the refresh computes.** The target tree STARTS as hub main's tree, then re-applies exactly the declared divergences. Preserve-by-default is the failure mode being corrected: it is what let 2,273 retired paths accumulate on a mirror that had fallen 667 commits behind. Deletions therefore propagate — except where REFRESH_IS_NOT_A_ROSTER_CHANGE declares otherwise.

**Why not an allowlist.** The prior attempt ([cogni-test-org/cogni-monorepo#60](https://github.com/cogni-test-org/cogni-monorepo/pull/60), closed unmerged) pinned "exactly 34 candidate-local paths may differ" and enforced it with a bespoke parity script committed to the mirror. Both halves are the anti-pattern: an allowlist puts every newly added canonical path OUT of scope until a human remembers to add it, and a mirror-local enforcement script is precisely the test-specific reimplementation TEST_PARENT_IS_NEAR_IDENTICAL forbids. Default-deny inverts the first; hub-owned mechanism inverts the second.

## Sync Mechanism

### v1 — Manifest + Drift-Detector Workflow (ships in this PR)

**As-built.** `.github/workflows/sync-drift-detector.yml` runs `scripts/ci/detect-sync-drift.mjs` on a daily schedule, on push:main when the manifest or detector itself changes, and on `workflow_dispatch`. The detector clones each declared `public` artifact at HEAD, walks every hub file not covered by `exclude` or the artifact's `omit_from_artifact`, sha256-diffs each, then classifies drift into:

- 🟡 **different** — same path on both, content mismatch.
- 🔴 **missing-on-artifact** — hub has it, artifact doesn't, divergence does not declare the omission.
- 🟣 **only-on-artifact** — artifact has it, hub doesn't, divergence does not declare the addition (backflow candidate).

The workflow upserts a tracking issue on the hub labeled `sync-drift` with the markdown report as the body. Issue title carries the count; body uses collapsible `<details>` per drift class. Existing open issue is updated in place (idempotent). Zero drift + no existing issue = no-op.

**Permissions.** `contents: read` + `issues: write` on the hub. No PAT, no GitHub App — the default `GITHUB_TOKEN` is sufficient for v0.1 because:

- Public artifacts (`Cogni-DAO/standalone-node`) are cloned anonymously.
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

The Caddyfile and `deploy-infra.sh` / `provision-env-vm.sh` per-node env-var blocks are catalog-driven (task.5078): `scripts/ci/render-caddyfile.sh` generates the Caddyfile from `NODE_TARGETS` (upstream port from catalog `node_port`) and the deploy/provision scripts write each node's per-env host from one `host_for_node` loop, so a fork adding a second node touches no operator-scope edge path — only its catalog entry. `scripts/ci/tests/render-caddyfile.test.sh` guards the drift. The remaining single-node assumption is the runtime compose per-service blocks + `infra/k8s/overlays/<env>/<node>` generation (ci-cd.md axiom 16 out-of-scope follow-ups).

The property is asserted by the CONTRACT_TEST below.

---

## CONTRACT_TEST

A repeatable validation that the contract holds end-to-end. **This test becomes load-bearing only after MULTI_NODE_OUT_OF_BOX is green** ([proj.repo-sync](../../work/projects/proj.repo-sync.md) slice S4). Before that, it documents the target state, not current state.

1. Fork `Cogni-DAO/standalone-node` to a fresh GitHub account.
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
