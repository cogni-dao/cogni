---
id: task.5081.handoff
type: handoff
work_item_id: task.5081
status: active
created: 2026-05-30
updated: 2026-05-30
branch: derekg1729/task5081-secrets-substrate-stage
last_commit: bd5dda8db
---

# Handoff: Repo-sync coordination + OpenBao/ESO substrate landing in the hub

## Context

- You own **repo-sync coordination**: keeping the hub (`Cogni-DAO/cogni`) and its artifacts (`Cogni-DAO/node-template`, `Cogni-DAO/cogni-poly`) aligned per the [repo-sync-contract](../../docs/spec/repo-sync-contract.md) landed in [#1355](https://github.com/Cogni-DAO/cogni/pull/1355).
- The active push: graduate the **Tier-1 secrets substrate** (OpenBao + External Secrets Operator + per-node catalog loader) from node-template's `artifact_only` block **into the hub**, then activate it per environment.
- Substrate is **proven end-to-end on node-template canary** (`i-am-coco`) as of 2026-05-30: ExternalSecrets `SecretSynced`, k8s Secrets populated from OpenBao, pod `envFrom` 0 restarts. It is real, not aspirational.
- The hub has **no production users** — Derek authorized **fresh provisioning** (tofu destroy+apply) of each env, so no in-place migration is needed.
- Plan is staged in `/Users/derek/.claude/plans/distributed-tinkering-knuth.md` (CP1 → CP2a/b/c).

## Current State

- **CP1 — hub substrate stage** → [PR #1384](https://github.com/Cogni-DAO/cogni/pull/1384), CI green, **under review by another dev**. Pure verbatim port; substrate is **dormant** (no kustomization references the new Argo Apps, no overlay reads the new ExternalSecrets, `scripts/setup-secrets.ts` keeps its inline `SECRETS` array). Runtime risk: zero.
- **Dev-freeze on node-template** → [Cogni-DAO/node-template#66](https://github.com/Cogni-DAO/node-template/pull/66), open. Adds a freeze banner to root `AGENTS.md`; the matching manifest divergence (`AGENTS.md` → node-template `artifact_only`) is folded into #1384.
- **Drift tracking** = hub issue [#1366](https://github.com/Cogni-DAO/cogni/issues/1366) ("sync-drift: 433 items"). Many items are node-template substrate files that clear once CP1 merges + CP1b lands.
- **NOT started**: CP1b (node-template-domain catalog), CP2a/b/c (per-env activation + fresh provision). No code review or candidate validation done on CP1 yet.

## Decisions Made

- **Stage-then-activate, not all-in-one** — CP1 stages dormant; activation is per-env via fresh provision. Avoids reimplementation and keeps each merge boundary's flight/promote pipeline intact.
- **Verbatim port** — substrate (`scripts/lib/secrets-catalog-loader.ts`, `infra/k8s/argocd/{openbao,external-secrets}/`, catalog YAML, specs) copied byte-for-byte from node-template; only ~2% adaptation (per-node YAMLs for hub-only nodes + env-name templating). See [#1384](https://github.com/Cogni-DAO/cogni/pull/1384) body.
- **Bootstrap.sh deferred** — left in node-template `artifact_only`: it sources `lib/fork-identity.sh`; hub uses `lib/cogni-deployment-identity.sh`. Reconcile separately.
- **CP1 candidate-flight is theatrical, skipped** — flights deploy app images, not the dormant Argo Apps; CP1 touches zero app code so the deployed artifact is byte-identical. Real `/validate-candidate` belongs in **CP2a** where bao actually activates.

## Next Actions

- [ ] Land CP1: get [#1384](https://github.com/Cogni-DAO/cogni/pull/1384) reviewed → merge (squash). Confirm `sync-drift-detector` next run shows zero residual on graduated paths + existing Argo Apps stay Synced.
- [ ] Land node-template freeze [#66](https://github.com/Cogni-DAO/node-template/pull/66) (docs-only, should be quick).
- [ ] **CP1b** (node-template-domain PR): `nodes/node-template/.cogni/secrets-catalog.yaml` + `nodes/node-template/k8s/external-secrets/candidate-a/` — port from node-template.
- [ ] **CP2a** (operator-domain): add `infra/catalog/openbao.yaml` + ApplicationSet generator entry + cloud-init bao-seed; `tofu destroy+apply` candidate-a; seed via `pnpm secrets:set`; then `/validate-candidate` (bao pod up, ExternalSecret SecretSynced, pod envFrom from ESO, request in Loki at SHA).
- [ ] **CP2b** preview, **CP2c** production — each after the prior env soaks. One PR per env.
- [ ] Work down [#1366](https://github.com/Cogni-DAO/cogni/issues/1366) drift queue: port flagged files hub→artifact verbatim; never re-implement.

## Risks / Gotchas

- **Single-node-scope gate**: CP2's openbao/catalog edits are operator-domain — keep node-domain (`nodes/X/`) edits in their own PRs or the gate fails. See `tests/ci-invariants/classify.ts` (RIDE_ALONG list).
- **Argo is catalog-driven**: adding `infra/k8s/argocd/openbao/` does nothing until you also add `infra/catalog/openbao.yaml` + a generator in the env ApplicationSet. This is why CP1 is safely dormant — and what CP2a must wire.
- **OpenBao unseal**: fresh provision yields a _sealed_ bao. Bootstrap must init + unseal + escrow Shamir keys off-VM (charter L5: `NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP`). Confirm `provision-env-vm.sh` Phase 5b handles this before CP2a flight.
- **ESO canary naming**: when wiring the first ExternalSecret on a live env, target a NEW Secret name — do not collide with the imperative `<node>-node-app-secrets` still in use.
- **`check-root-layout`**: any new repo-root file must be allowlisted in `scripts/check-root-layout.ts` (bit us on `.env.bootstrap.example`).

## Pointers

| File / Resource                                                                   | Why it matters                                                                                 |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| [PR #1384](https://github.com/Cogni-DAO/cogni/pull/1384)                          | CP1 substrate stage (under review)                                                             |
| [node-template#66](https://github.com/Cogni-DAO/node-template/pull/66)            | Dev-freeze banner                                                                              |
| [issue #1366](https://github.com/Cogni-DAO/cogni/issues/1366)                     | Sync-drift queue (the work list)                                                               |
| `docs/spec/repo-sync-contract.md`                                                 | 7 invariants; hub↔artifact direction-of-flow                                                  |
| `scripts/ci/detect-sync-drift.mjs`                                                | Detector logic (sha256-diff; omit/artifact_only suppress)                                      |
| `.cogni/sync-manifest.yaml`                                                       | Divergence SSOT; edit divergence blocks here                                                   |
| `scripts/lib/secrets-catalog-loader.ts`                                           | Zod catalog loader (ported, runs clean on hub: 39 entries)                                     |
| `infra/secrets-catalog.yaml`                                                      | Operator-domain catalog (`_shared`/`_system`/B/D/E/G + A2 poly)                                |
| `docs/spec/{secrets-management,secrets-classification,access-control-charter}.md` | Tier system + invariants + L0–L5 layer cake                                                    |
| `.claude/skills/cicd-secrets-expert/SKILL.md`                                     | One-page secrets reference (decision trees, anti-patterns)                                     |
| `infra/k8s/argocd/candidate-a-applicationset.yaml`                                | The generator shape CP2a must extend for openbao                                               |
| `/Users/derek/.claude/plans/distributed-tinkering-knuth.md`                       | Full CP1→CP2 plan                                                                              |
| node-template canary                                                              | `/Users/derek/dev/canary/cogni-node-20260528/.local/` (kubeconfig — proof the substrate works) |
