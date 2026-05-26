---
id: spec.repo-sync-contract
type: spec
title: Multi-Repo Sync Contract
status: draft
trust: draft
summary: Topology, scope manifest, and sync mechanism for keeping operator-scope content aligned across the cogni monorepo (hub), node-template, and per-node forks (cogni-poly).
read_when: Editing operator-scope content (scripts/ci, infra/k8s/base, .github/workflows, scripts/setup, infra/compose, infra/catalog), labeling a PR `needs-upstream-sync`, or deciding which repo a fix belongs in.
implements: []
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

- `Cogni-DAO/cogni` — the **monorepo hub**. Holds `nodes/operator/` plus all per-node scopes (poly, resy, future nodes), the canonical `scripts/ci/`, `infra/k8s/base/`, `.github/workflows/`, `infra/compose/`, `infra/catalog/`.
- `Cogni-DAO/node-template` — the **OSS template artifact**. Public surface for forks. Holds `nodes/node-template/` (operator-equivalent) + a copy of operator-scope infrastructure.
- `Cogni-DAO/cogni-poly` — a **per-node fork artifact**. Polymarket-specific node that historically branched off and continues to land operator-scope CI/infra fixes that the hub needs.

Operator-scope fixes have been diverging across these three repos with no shared lineage. Concrete evidence at spec authoring time (2026-05-26):

- `scripts/ci/wait-for-in-cluster-services.sh` is **byte-identical** between cogni monorepo and node-template, and both still carry the hardcoded `case "$node" in operator|poly|resy)` allowlist that cogni-poly [PR #127](https://github.com/Cogni-DAO/cogni-poly/pull/127) eliminated upstream on 2026-05-20.
- 14+ cogni-poly PRs are labeled `needs-upstream-sync` and remain unmerged into the hub (see Appendix A).
- The bug.5001 pattern (same problem fixed in two repos with two different patches and no shared lineage) repeated as cogni [PR #1348](https://github.com/Cogni-DAO/cogni/pull/1348) vs node-template's bug.5001 fix.

This is a recurring, accruing class of incident. The label-and-hand-port pattern is not scaling.

## Goal

Define the contract that:

1. Names a single hub for operator-scope content (cogni monorepo).
2. Declares operator-scope paths in a machine-readable manifest checked into the hub.
3. Specifies a mechanism that surfaces drift as actionable PRs rather than silent divergence.
4. Requires the hub to ship multi-node fundamentals so downstream artifacts inherit them rather than re-implementing.

## Non-Goals

- The drift-detector workflow itself (separate slice — see `## Roadmap`).
- Backfilling the 14-PR sync backlog (separate slice).
- Migrating cogni-poly's content into the monorepo (separate question).
- Touching the cogni repo (separate coordination with operator-app owners).
- Per-node review policy or CI invariants — see [spec.node-ci-cd-contract](./node-ci-cd-contract.md).

---

## Core Invariants

1. **HUB_IS_COGNI_MONOREPO**: `Cogni-DAO/cogni` is the canonical hub for all operator-scope content. Fixes land in the hub first; artifacts pull. Direct edits to operator-scope paths in `node-template` or `cogni-poly` are tolerated but the contract requires they round-trip through a hub PR within one sync cycle.

2. **MANIFEST_IS_SSOT**: `.cogni/sync-manifest.yaml` (in each repo, kept identical via the same sync mechanism) is the single declaration of which paths are operator-scope. No path is in scope unless declared. Adding a path to scope is itself a hub PR.

3. **DECLARED_DIVERGENCE**: Any intentional divergence between a hub path and its artifact counterpart MUST appear in the manifest's `divergences:` block with a `reason:` field. Undeclared divergence is a contract violation surfaced by the drift detector.

4. **MULTI_NODE_OUT_OF_BOX**: The hub MUST ship multi-node fundamentals (catalog-driven Caddyfile, catalog-driven `deploy-infra.sh` per-node env vars, catalog-driven CI gating). node-template inherits these and ships them in fork-quickstart even though it ships with one node today. Single-node hardcoding in operator-scope paths is a contract violation regardless of which repo it lives in.

5. **ONE_FIX_ONE_LINEAGE**: A fix that addresses the same root cause as an existing upstream PR MUST cite the upstream PR in its description and be cherry-picked or rebased onto upstream's commit, not re-implemented. Reviewers reject parallel fixes with no shared lineage.

6. **CATALOG_BOUNDARY**: `infra/catalog/*.yaml` is the API between operator-scope and per-node scope. Operator-scope code reads from the catalog and never special-cases node names. Per-node bits (a node's own `nodes/<name>/`) are downstream-only and do not propagate up.

---

## Topology

```
                    Cogni-DAO/cogni  (HUB)
                    ── nodes/operator/         (operator-scope source)
                    ── nodes/poly/             (per-node)
                    ── nodes/resy/             (per-node)
                    ── scripts/ci/             (operator-scope)
                    ── infra/k8s/base/         (operator-scope)
                    ── infra/k8s/argocd/       (operator-scope)
                    ── infra/compose/          (operator-scope)
                    ── infra/catalog/          (operator-scope; API boundary)
                    ── .github/workflows/      (operator-scope)
                    ── scripts/setup/          (operator-scope)
                    ── .cogni/sync-manifest.yaml  (SSOT for what is in scope)
                         │
            ┌────────────┴────────────┐
            ▼                          ▼
   Cogni-DAO/node-template       Cogni-DAO/cogni-poly
   (OSS template artifact)       (per-node fork artifact)
   - nodes/node-template/         - nodes/poly/         (per-node, hub-mirrored)
     (= cogni's nodes/operator/)  - operator-scope paths (hub-mirrored)
   - operator-scope paths
     (hub-mirrored)
```

**Primary flow:** hub → artifacts (forward sync).
**Edge-case flow:** artifact → hub → artifacts (backflow, when a fix lands in cogni-poly first; must round-trip through hub).

---

## Operator-Scope Manifest

Location: `.cogni/sync-manifest.yaml` at repo root.

```yaml
# .cogni/sync-manifest.yaml
schema: 1
hub: Cogni-DAO/cogni
artifacts:
  - repo: Cogni-DAO/node-template
    path_map:
      # cogni path → node-template path (only declare when they differ)
      "nodes/operator/": "nodes/node-template/"
  - repo: Cogni-DAO/cogni-poly
    path_map: {} # 1:1 path mapping

# Paths that are operator-scope.
# A change to any path under these globs in the hub must be reflected
# in every artifact (modulo path_map and declared divergences).
scope:
  - "scripts/ci/**"
  - "scripts/setup/**"
  - "infra/k8s/base/node-app/**"
  - "infra/k8s/base/scheduler-worker/**"
  - "infra/k8s/argocd/**"
  - "infra/k8s/secrets/external-secrets/**"
  - "infra/compose/edge/**"
  - "infra/catalog/_schema.json"
  - ".github/workflows/**"
  - "docs/spec/ci-cd.md"
  - "docs/spec/secrets-management.md"
  - "docs/spec/repo-sync-contract.md"

# Paths within scope where divergence is intentional.
# The drift detector ignores these. Adding an entry requires
# a hub PR with the reason field populated.
divergences:
  - path: "infra/catalog/operator.yaml"
    repos: [Cogni-DAO/cogni-poly]
    reason: "cogni-poly does not ship the operator node."
  - path: "infra/catalog/resy.yaml"
    repos: [Cogni-DAO/node-template, Cogni-DAO/cogni-poly]
    reason: "Hub-only node; not part of the multi-node template fixtures."
  - path: ".github/workflows/release.yml"
    repos: [Cogni-DAO/node-template]
    reason: "node-template has no production environment; release workflow is hub-only."
```

The schema, validation, and CI enforcement of this file are implemented in the v1 slice (`## Roadmap`).

---

## Sync Mechanism

### v1 — Manifest + Drift-Detector Bot

**Approach.** A scheduled GitHub Actions workflow in the hub (`drift-detector.yml`) runs daily and on hub merges to `main`. For each artifact repo + each in-scope path, it diffs the hub against the artifact, applies the `path_map` + `divergences` rules, and opens (or updates) an auto-PR on the artifact repo with the proposed change. A second workflow on each artifact repo validates that the local manifest matches the hub's.

**Why this first.**

- Doesn't introduce a hosted daemon.
- The manifest is the load-bearing artifact; it's the prerequisite for v2 (josh) anyway.
- Surfaces drift as PRs that reviewers can accept, modify, or document as intentional via a manifest edit.
- Pareto: covers the bug.5001 + 14-PR-backlog class of incident at ~200 LOC of CI.

**Hard requirements before v1 is considered complete.**

- `.cogni/sync-manifest.yaml` present and validated in all three repos.
- Drift detector reports clean (no undeclared divergence) on a daily run.
- The 14-PR backlog (Appendix A) has either landed in the hub or has an intentional `divergences:` entry with reason.
- Documentation: `docs/runbooks/upstream-sync.md` explaining the contributor workflow (where to land a fix, how to handle a backflow).

**Acceptance test.** A test run: pick one in-scope file, edit it on the hub via a one-line PR, merge, and observe a drift-detector PR appear on each artifact repo within 24h. Per CONTRACT_TEST in `## Roadmap`.

### v2 — Josh-Proxy as Shape A Catalog Service

**Approach.** Deploy [josh-proxy](https://josh-project.github.io/josh/) as a Shape A catalog service (validated via the [cogni-poly#128](https://github.com/Cogni-DAO/cogni-poly/pull/128) onboarding pattern). Define josh filters that expose operator-scope subdirectories of the cogni monorepo as virtual git repos. Artifacts (`node-template`, `cogni-poly`) become filtered views: clone, edit, push back through the proxy, and changes apply to the hub with history preserved bidirectionally.

**Why second, not first.**

- Requires the manifest from v1 (filters are derived from `scope:`).
- Requires hosting a daemon (small VM or in-cluster pod) — platform-grade infra.
- Filter authoring is a DSL; bus-factor risk.
- Self-bootstrapping fit: deploying josh via the catalog _is_ the contract test for "adding a service is easy."

**Hard requirements before v2 is considered.**

- v1 has run cleanly for at least 30 days.
- Drift-detector has surfaced ≥3 backflow cases (artifact → hub) — proving bidirectional sync is the actual need, not just forward sync.
- Manifest schema has stabilized (no breaking changes in 30 days).

**v2 entry criterion.** If v1 is sustainable and bidirectional friction is low, v2 may be deferred indefinitely. v2 ships only if the friction cost of manifest-driven PR review exceeds the infra cost of running josh.

---

## Drift Acceptance Rules

A divergence between hub and artifact falls into exactly one of:

| Class             | Definition                                                                             | Resolution                                                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Intentional**   | Path is in scope, but artifact MUST differ (e.g., node-template has no `release.yml`). | Declared in manifest `divergences:` with `reason:` field. Drift detector ignores.                                                  |
| **Pending**       | Hub has a change not yet synced to artifact.                                           | Drift detector opens auto-PR on artifact.                                                                                          |
| **Backflow**      | Artifact has a change not yet round-tripped through hub.                               | Drift detector opens auto-PR on **hub**, blocks artifact-side merges that don't reference a hub PR.                                |
| **Unintentional** | Neither side knows the divergence exists.                                              | Drift detector opens both: an audit issue on hub + an auto-PR on whichever side is canonical-by-recency. Requires manual judgment. |

A path is **never** in two classes. If it would be, the manifest is wrong and must be updated.

---

## Multi-Node-Readiness Load-Bearing Test

The contract's correctness is asserted by a single property: **node-template, with zero edits to operator-scope paths, must be able to host a fork that adds a second node.**

This property is currently red — the Caddyfile template and `deploy-infra.sh` per-node env-var block both hardcode single-node assumptions (see bug.5001 lineage). Driving this red→green is a follow-on slice and is a precondition for declaring the contract live.

The property is checked by the contract test in `## Roadmap` (CONTRACT_TEST).

---

## Roadmap

| Slice                         | Deliverable                                                                                                    | Gate                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **S0 — this PR**              | This spec + divergence appendix + manifest schema.                                                             | Spec reviewed by Derek.                                                                |
| **S1 — manifest**             | `.cogni/sync-manifest.yaml` lands in all three repos. CI validates schema.                                     | All three repos have a manifest; no validator errors.                                  |
| **S2 — drift detector v1**    | `.github/workflows/drift-detector.yml` opens auto-PRs on artifact repos. Hub-side runbook.                     | One synthetic edit on hub produces auto-PRs on both artifacts within 24h.              |
| **S3 — backlog drain**        | Cherry-pick the 14 cogni-poly PRs (Appendix A) into hub. Cascade via drift detector.                           | Drift detector reports clean on a daily run.                                           |
| **S4 — multi-node-readiness** | Catalog-driven Caddyfile + `deploy-infra.sh`. Promote cogni's multi-node patterns up to node-template.         | CONTRACT_TEST passes: fresh node-template fork adds a 2nd node via catalog-only edits. |
| **S5 — v2 evaluation**        | Pressure-test josh after S1–S4 run for 30 days. Decision: ship josh as catalog service, or defer indefinitely. | Documented ROI judgment, not a default.                                                |

S0–S2 are the irreducible v1. S3 demonstrates v1. S4 closes the multi-node-readiness debt. S5 is conditional.

---

## CONTRACT_TEST

A repeatable validation that the contract holds end-to-end:

1. Fork `Cogni-DAO/node-template` to a fresh GitHub account.
2. Add a second node entry to `infra/catalog/` (per `_schema.json`).
3. Add `nodes/<name>/` with the minimal Shape A service skeleton ([cogni-poly#128 reference](https://github.com/Cogni-DAO/cogni-poly/pull/128)).
4. Run `pnpm check:catalog` and the standard CI gates.
5. Push to a fork and observe a green build.

**Pass criterion:** zero edits to any operator-scope path (per the manifest `scope:` glob).
**Fail criterion:** any required edit outside of `nodes/<name>/` and `infra/catalog/<name>.yaml`.

This test is the load-bearing assertion that the contract is real. It is run manually on each contract-affecting PR until S2 automates it.

---

## Appendix A — Divergence Enumeration (2026-05-26)

This appendix is a **read-only audit** of current operator-scope divergence between repos. It does not propose fixes — those are downstream slices (S3 in `## Roadmap`).

### A.1 — Confirmed file-level divergence

| File                                         | Hub (cogni)                | node-template                     | cogni-poly                                                                | Class                                |
| -------------------------------------------- | -------------------------- | --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `scripts/ci/wait-for-in-cluster-services.sh` | hardcoded `case` allowlist | **byte-identical to hub** (stale) | catalog-driven ([#127](https://github.com/Cogni-DAO/cogni-poly/pull/127)) | Backflow                             |
| `scripts/ci/report-candidate-status.sh`      | no 140-char clamp          | no 140-char clamp                 | 140-char clamp ([#127](https://github.com/Cogni-DAO/cogni-poly/pull/127)) | Backflow                             |
| `infra/compose/edge/configs/Caddyfile.tmpl`  | multi-node-ish             | single-node (bug.5001)            | single-node ([#51](https://github.com/Cogni-DAO/cogni-poly/pull/51))      | Unintentional — same fix, no lineage |
| `infra/catalog/_schema.json`                 | catalog v1                 | catalog v1                        | **catalog v2** ([#61](https://github.com/Cogni-DAO/cogni-poly/pull/61))   | Backflow — architectural             |

Full file-level enumeration is out of scope for S0; the drift detector (S2) is the mechanism that produces the complete list.

### A.2 — `needs-upstream-sync` PR backlog (cogni-poly → hub)

Closed/merged `needs-upstream-sync`-labeled PRs in cogni-poly that have not been ported into the hub as of 2026-05-26:

| PR                                                       | Title                                                                                 | Class                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [#42](https://github.com/Cogni-DAO/cogni-poly/pull/42)   | `fix(deploy-infra): demote POSTHOG_API_KEY/HOST from required to optional`            | Backflow                                               |
| [#43](https://github.com/Cogni-DAO/cogni-poly/pull/43)   | `fix(cicd): checkout workflow ref (control plane) for deploy-infra job`               | Backflow                                               |
| [#44](https://github.com/Cogni-DAO/cogni-poly/pull/44)   | `fix(deploy-infra): db-backup race — validate before systemd --now (bug.5169)`        | Backflow                                               |
| [#50](https://github.com/Cogni-DAO/cogni-poly/pull/50)   | `fix(infra): deploy scheduler-worker to candidate-a + preview (bug.5000)`             | Backflow                                               |
| [#51](https://github.com/Cogni-DAO/cogni-poly/pull/51)   | `fix(infra/compose): single-node Caddyfile.tmpl for cogni-poly (bug.5001)`            | Unintentional                                          |
| [#52](https://github.com/Cogni-DAO/cogni-poly/pull/52)   | `fix(ci): catalog-declared public_url for verify scripts (bug.5002)`                  | Backflow — catalog v2                                  |
| [#53](https://github.com/Cogni-DAO/cogni-poly/pull/53)   | `fix(ci): pass DEPLOY_ENVIRONMENT into verify job`                                    | Backflow                                               |
| [#61](https://github.com/Cogni-DAO/cogni-poly/pull/61)   | `feat(ci): catalog v2 — separate deploy units from build units`                       | Backflow — architectural                               |
| [#70](https://github.com/Cogni-DAO/cogni-poly/pull/70)   | `feat(ci): catalog v2 — sidecar shape lives in kustomize Components`                  | Backflow — architectural                               |
| [#72](https://github.com/Cogni-DAO/cogni-poly/pull/72)   | `feat(ci): catalog v2 — Shape A re-exercise via poly-test-worker`                     | Backflow — architectural                               |
| [#75](https://github.com/Cogni-DAO/cogni-poly/pull/75)   | `fix(ci): snapshot/restore image-aware (catalog v2 multi-image overlays)`             | Backflow                                               |
| [#81](https://github.com/Cogni-DAO/cogni-poly/pull/81)   | `fix(ci): bug.5009 — flight-preview silent-skip on zero-affected merges`              | Backflow                                               |
| [#82](https://github.com/Cogni-DAO/cogni-poly/pull/82)   | `fix(ci): classify-pr-build-state race + matrix-leg filter`                           | Backflow                                               |
| [#84](https://github.com/Cogni-DAO/cogni-poly/pull/84)   | `fix(ci): bug.5011 — flight-preview retag word-prefix collision`                      | Backflow                                               |
| [#85](https://github.com/Cogni-DAO/cogni-poly/pull/85)   | `fix(ci): bug.5012 — preview/production placeholder-fill self-heal`                   | Backflow                                               |
| [#118](https://github.com/Cogni-DAO/cogni-poly/pull/118) | `fix(ci): bug.5013 — deploy branch owns digests on promote`                           | Backflow                                               |
| [#123](https://github.com/Cogni-DAO/cogni-poly/pull/123) | `feat(ci): task.5006 — image-native build-provenance via OCI labels`                  | Backflow                                               |
| [#127](https://github.com/Cogni-DAO/cogni-poly/pull/127) | `fix(ci): catalog-driven rollout gating + clamp status descriptions`                  | Backflow — the minimum slice for zero-edit-per-service |
| [#128](https://github.com/Cogni-DAO/cogni-poly/pull/128) | `feat(infra): revalidate Shape A onboarding on catalog-driven CI`                     | Backflow — contract test                               |
| [#132](https://github.com/Cogni-DAO/cogni-poly/pull/132) | `feat(ci): task.5013 — auto-bootstrap per-node deploy branches on cold-start promote` | Backflow                                               |

Hub PRs labeled `needs-upstream-sync` that have not been synced down to artifacts as of 2026-05-26:

| PR                                                         | Title                                                                   | Direction                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------ |
| [cogni#1335](https://github.com/Cogni-DAO/cogni/pull/1335) | `refactor: move @cogni/node-template-knowledge → @cogni/knowledge-base` | Forward                                                |
| [cogni#1344](https://github.com/Cogni-DAO/cogni/pull/1344) | `feat(knowledge): HTML renderer shell — tokens + cogni-* utilities`     | Forward (likely out of scope; manifest review pending) |
| [cogni#1347](https://github.com/Cogni-DAO/cogni/pull/1347) | `fix(db): doltgres migration safety + 1:1 parity with postgres`         | Forward (in-scope confirmation pending)                |

### A.3 — Known TBD items

- The full list of single-node hardcodings in node-template (bug.5001 lineage) requires the drift detector to enumerate. Tracked at the slice level in S4.
- Whether cogni-poly should re-merge into the monorepo long-term is **out of scope** for this spec. The contract works regardless of that decision.

---

## References

- [spec.node-ci-cd-contract](./node-ci-cd-contract.md) — CI invariants per node; this spec is the cross-repo complement.
- [spec.private-node-repo-contract](./private-node-repo-contract.md) — related artifact-vs-template framing.
- [cogni-poly#127](https://github.com/Cogni-DAO/cogni-poly/pull/127) — Exhibit A: catalog-driven CI fix that failed to upstream.
- [cogni-poly#128](https://github.com/Cogni-DAO/cogni-poly/pull/128) — Shape A onboarding validation; the pattern v2 would deploy josh through.
- [cogni#1348](https://github.com/Cogni-DAO/cogni/pull/1348) — parallel bug.5001 fix that motivated this spec.
- [josh-project](https://josh-project.github.io/josh/) — v2 mechanism candidate.
