---
id: proj.repo-sync
type: project
primary_charter:
title: Multi-Repo Sync
state: Active
priority: 2
estimate: 8
summary: Land the contract + tooling that keeps operator-scope content aligned across cogni monorepo (hub), node-template, and cogni-poly (artifacts).
outcome: An operator-scope fix lands once in the hub, propagates to all three repos via the drift detector, divergence is auto-surfaced as PRs, and the 20-PR backlog is drained.
assignees:
  - derekg1729
created: 2026-05-26
updated: 2026-05-26
labels:
  - ci-cd
  - deployment
  - meta
---

# Multi-Repo Sync

## Goal

Stop the bug.5001 anti-pattern: same problem solved in two repos with two different patches and no shared lineage. Drive the contract defined in [spec.repo-sync-contract](../../docs/spec/repo-sync-contract.md) from S0 → S5 over the next 30–60 days.

## Status

```
S0 spec   ─►  S1 manifest  ─►  S2 detector  ─►  S3 backlog drain  ─►  S4 multi-node  ─►  S5 josh decision
DONE            DONE           DONE            NEXT                 PLANNED            CONDITIONAL
```

S0 + S1 + S2 all shipped in [PR #1355](https://github.com/Cogni-DAO/cogni/pull/1355) (task.5068). First detector run against current `origin/main` (recorded in PR #1355) finds **171 drift items** between hub and `Cogni-DAO/node-template`, including the load-bearing bug.5001 anti-pattern (`.github/workflows/ci.yaml` differs).

## Current Slice

**S3 — backlog drain.** Use the now-live drift detector report to drive cherry-picks of the 20 cogni-poly `needs-upstream-sync` PRs into the hub. Each merge re-runs the detector workflow; the hub `sync-drift` tracking issue shrinks as drift is resolved. Cogni-poly coverage itself remains v0.2 (needs a PAT for the private clone).

## Roadmap

| Slice  | Deliverable                                                                                                                                          | Gate                                                                                   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **S0** | [spec.repo-sync-contract](../../docs/spec/repo-sync-contract.md) + this project                                                                      | Spec reviewed by Derek.                                                                |
| **S1** | `.cogni/sync-manifest.yaml` (inverse form, schema 2) lands in the hub. check-jsonschema + cross-ref validator in ci.yaml.                            | Both validators fail-closed on broken manifest (proven in CI on scratch PR).           |
| **S2** | `.github/workflows/sync-drift-detector.yml` runs `scripts/ci/detect-sync-drift.mjs` on schedule + push:main; upserts hub issue labeled `sync-drift`. | First run identifies the bug.5001 anti-pattern (ci.yaml differs hub vs node-template). |
| **S3** | Cherry-pick the 20 cogni-poly `needs-upstream-sync` PRs (see Backlog) into the hub. Cascade via the detector.                                        | Drift detector reports clean on a daily run.                                           |
| **S4** | Catalog-driven Caddyfile.tmpl + `deploy-infra.sh` per-node env-var block. Promote cogni's multi-node patterns up to node-template.                   | CONTRACT_TEST in the spec passes against current main.                                 |
| **S5** | Pressure-test josh-proxy after S1–S4 run for 30 days. Decision: ship josh as a Shape A catalog service, or defer indefinitely.                       | Documented ROI judgment, not a default.                                                |

## Active Blockers

| #   | Issue                                                                                         | Status  | Impact                                       |
| --- | --------------------------------------------------------------------------------------------- | ------- | -------------------------------------------- |
| 1   | 20 cogni-poly PRs unsynced (see Backlog)                                                      | ❌ RED  | exhibit A; resolves in S3                    |
| 2   | byte-identical-stale `scripts/ci/wait-for-in-cluster-services.sh` between hub + node-template | ❌ RED  | concrete divergence; surfaced by S2 detector |
| 3   | Caddyfile.tmpl + `deploy-infra.sh` single-node-hardcoded (bug.5001 lineage)                   | ❌ RED  | S4 fix                                       |
| 4   | cogni-poly visibility=private — detector skips it in v0.1                                     | 🟡 V0.2 | v0.2 plumbing (PAT or GitHub App install)    |

## Backlog — cogni-poly PRs awaiting upstream sync (2026-05-26)

Closed/merged `needs-upstream-sync`-labeled PRs in `Cogni-DAO/cogni-poly` that have not been ported into the hub:

| PR                                                       | Title                                                                                 | Class                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------- |
| [#42](https://github.com/Cogni-DAO/cogni-poly/pull/42)   | `fix(deploy-infra): demote POSTHOG_API_KEY/HOST from required to optional`            | Backflow                                           |
| [#43](https://github.com/Cogni-DAO/cogni-poly/pull/43)   | `fix(cicd): checkout workflow ref (control plane) for deploy-infra job`               | Backflow                                           |
| [#44](https://github.com/Cogni-DAO/cogni-poly/pull/44)   | `fix(deploy-infra): db-backup race — validate before systemd --now (bug.5169)`        | Backflow                                           |
| [#50](https://github.com/Cogni-DAO/cogni-poly/pull/50)   | `fix(infra): deploy scheduler-worker to candidate-a + preview (bug.5000)`             | Backflow                                           |
| [#51](https://github.com/Cogni-DAO/cogni-poly/pull/51)   | `fix(infra/compose): single-node Caddyfile.tmpl for cogni-poly (bug.5001)`            | Unintentional — folds into S4                      |
| [#52](https://github.com/Cogni-DAO/cogni-poly/pull/52)   | `fix(ci): catalog-declared public_url for verify scripts (bug.5002)`                  | Backflow — catalog v2                              |
| [#53](https://github.com/Cogni-DAO/cogni-poly/pull/53)   | `fix(ci): pass DEPLOY_ENVIRONMENT into verify job`                                    | Backflow                                           |
| [#61](https://github.com/Cogni-DAO/cogni-poly/pull/61)   | `feat(ci): catalog v2 — separate deploy units from build units`                       | Backflow — architectural                           |
| [#70](https://github.com/Cogni-DAO/cogni-poly/pull/70)   | `feat(ci): catalog v2 — sidecar shape lives in kustomize Components`                  | Backflow — architectural                           |
| [#72](https://github.com/Cogni-DAO/cogni-poly/pull/72)   | `feat(ci): catalog v2 — Shape A re-exercise via poly-test-worker`                     | Backflow — architectural                           |
| [#75](https://github.com/Cogni-DAO/cogni-poly/pull/75)   | `fix(ci): snapshot/restore image-aware (catalog v2 multi-image overlays)`             | Backflow                                           |
| [#81](https://github.com/Cogni-DAO/cogni-poly/pull/81)   | `fix(ci): bug.5009 — flight-preview silent-skip on zero-affected merges`              | Backflow                                           |
| [#82](https://github.com/Cogni-DAO/cogni-poly/pull/82)   | `fix(ci): classify-pr-build-state race + matrix-leg filter`                           | Backflow                                           |
| [#84](https://github.com/Cogni-DAO/cogni-poly/pull/84)   | `fix(ci): bug.5011 — flight-preview retag word-prefix collision`                      | Backflow                                           |
| [#85](https://github.com/Cogni-DAO/cogni-poly/pull/85)   | `fix(ci): bug.5012 — preview/production placeholder-fill self-heal`                   | Backflow                                           |
| [#118](https://github.com/Cogni-DAO/cogni-poly/pull/118) | `fix(ci): bug.5013 — deploy branch owns digests on promote`                           | Backflow                                           |
| [#123](https://github.com/Cogni-DAO/cogni-poly/pull/123) | `feat(ci): task.5006 — image-native build-provenance via OCI labels`                  | Backflow                                           |
| [#127](https://github.com/Cogni-DAO/cogni-poly/pull/127) | `fix(ci): catalog-driven rollout gating + clamp status descriptions`                  | Backflow — minimum slice for zero-edit-per-service |
| [#128](https://github.com/Cogni-DAO/cogni-poly/pull/128) | `feat(infra): revalidate Shape A onboarding on catalog-driven CI`                     | Backflow — contract test                           |
| [#132](https://github.com/Cogni-DAO/cogni-poly/pull/132) | `feat(ci): task.5013 — auto-bootstrap per-node deploy branches on cold-start promote` | Backflow                                           |

Hub PRs labeled `needs-upstream-sync` awaiting downstream propagation (forward direction):

| PR                                                         | Title                                                                   | Notes                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------- |
| [cogni#1335](https://github.com/Cogni-DAO/cogni/pull/1335) | `refactor: move @cogni/node-template-knowledge → @cogni/knowledge-base` | In-scope confirmation pending S1 manifest         |
| [cogni#1344](https://github.com/Cogni-DAO/cogni/pull/1344) | `feat(knowledge): HTML renderer shell — tokens + cogni-* utilities`     | Likely out of scope; manifest review will confirm |
| [cogni#1347](https://github.com/Cogni-DAO/cogni/pull/1347) | `fix(db): doltgres migration safety + 1:1 parity with postgres`         | In-scope confirmation pending                     |

## Confirmed file-level divergence (2026-05-26)

Evidence supporting the spec invariants. Full enumeration is the drift-detector's job (S2); this is a hand-audited snapshot to motivate S3.

| File                                         | Hub (cogni)                | node-template                     | cogni-poly                                                                | Class                                |
| -------------------------------------------- | -------------------------- | --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `scripts/ci/wait-for-in-cluster-services.sh` | hardcoded `case` allowlist | **byte-identical to hub** (stale) | catalog-driven ([#127](https://github.com/Cogni-DAO/cogni-poly/pull/127)) | Backflow                             |
| `scripts/ci/report-candidate-status.sh`      | no 140-char clamp          | no 140-char clamp                 | 140-char clamp ([#127](https://github.com/Cogni-DAO/cogni-poly/pull/127)) | Backflow                             |
| `infra/compose/edge/configs/Caddyfile.tmpl`  | multi-node-ish             | single-node (bug.5001)            | single-node ([#51](https://github.com/Cogni-DAO/cogni-poly/pull/51))      | Unintentional — same fix, no lineage |
| `infra/catalog/_schema.json`                 | catalog v1                 | catalog v1                        | **catalog v2** ([#61](https://github.com/Cogni-DAO/cogni-poly/pull/61))   | Backflow — architectural             |

## Known TBD

- Whether cogni-poly should re-merge into the monorepo long-term. The contract works regardless; track separately if/when it surfaces.
- Production josh deployment shape (in-cluster pod via catalog vs sidecar) — S5 question.

## Constraints

- **HUB_IS_COGNI_MONOREPO**: spec invariant — fixes land in hub first; artifacts pull.
- **MANIFEST_IS_SSOT**: `.cogni/sync-manifest.yaml` is the only declaration of operator-scope paths.
- **DECLARED_DIVERGENCE**: intentional differences must appear in the manifest's `divergences:` block with a reason.
- **ONE_FIX_ONE_LINEAGE**: parallel fixes with no shared lineage are rejected.
- **NO_DAEMON_AT_V1**: v1 ships as bot-on-CI, not as a hosted proxy; the manifest must be sufficient.

## Dependencies

- [x] `infra/catalog/_schema.json` exists in the hub (task.0374) — manifest piggybacks on the catalog SSOT pattern.
- [ ] cogni-poly catalog v2 backflow PRs (#61, #70, #72, #75) — required substrate for any cross-repo CI script port (S3 prerequisite).
- [ ] artifact-repo CI green on a synthetic manifest edit — S1 acceptance test.

## Design Notes

- Manifest schema is intentionally minimal at v1: `schema`, `hub`, `artifacts[]`, `scope[]`, `divergences[]`. Resist adding fields until v1 has run for 30 days; YAGNI dominates here.
- Drift-detector class taxonomy (Pending / Backflow / Unintentional / Intentional) is the load-bearing semantic. Off-the-shelf tools (repo-file-sync-action, Renovate regex managers, copier) don't model this; v1 stays bespoke.
- josh-proxy (S5) is evaluated only after 30 days of v1 operation. The acceptance question is friction-cost, not capability — v1 already covers capability.
- Backflow (artifact → hub) enforcement at v1 is a label + open-PR, not a required check. Hard branch protection deferred to v1.1 once volume justifies it.

## As-Built Specs

- [spec.repo-sync-contract](../../docs/spec/repo-sync-contract.md) — invariants, manifest schema, topology, CONTRACT_TEST.

## References

- [spec.repo-sync-contract](../../docs/spec/repo-sync-contract.md) — invariants this project implements
- [spec.node-ci-cd-contract](../../docs/spec/node-ci-cd-contract.md) — per-node CI invariants (complement)
- [proj.cicd-services-gitops](./proj.cicd-services-gitops.md) — hub-side CI pipeline project (consumes the contract)
- [josh-project](https://josh-project.github.io/josh/) — S5 mechanism candidate
