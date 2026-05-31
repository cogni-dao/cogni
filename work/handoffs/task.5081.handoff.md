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
- **Provisioner convergence: B (one shared provisioner), not A (extract substrate lib)** — 2026-05-30. The hub needs a provisioner that bootstraps OpenBao Phase 5b on fresh provision. Two candidates each held half: hub's `provision-test-vm.sh` (multi-node, no substrate, stale poly leftovers) vs fork's `provision-env-vm.sh` (Phase 5b substrate, but `exit 1` fork-guarded against `Cogni-DAO/cogni`). A prior session proposed **A** (extract a shared `substrate-install` both call) on the belief that B required "multi-node the seed (bigger)". **That belief was wrong**: `provision-env-vm.sh` is already monorepo-shaped — `NODE_TARGETS` from `image-tags.sh`, `COGNI_NODE_DBS` loops every node, per-node `repo-spec` resolution. The hub blockers are **two** runtime guards, not one (caught in implementation review — my first pass wrongly claimed "only one wall" after reading the second guard but not verifying operator's `node_id`): **(G1)** the origin allowlist (`exit 1` if origin matches `Cogni-DAO/cogni|node-template`); **(G2)** the per-node upstream-UUID check at L375 — operator's `node_id` on `origin/main` IS `UPSTREAM_NODE_ID` (`4ff8eac1…`, the hub's canonical identity), so the loop hits `exit 2` before Phase 5b. Both are now hub-corrected (G1 rejects only the bare template; G2 allows `Cogni-DAO/cogni` as a legitimate owner of that UUID — tenant isolation intact since true forks still must mint their own). So **B is still the smaller change** (two one-line guard edits vs maintaining a shared lib + two drifting provisioners) and the only end-state that satisfies the sync contract (one shared file, zero divergence — "sync repos on the monorepo's version") and `purge-legacy` (retire stale `provision-test-vm.sh`). **Scope honesty**: `reconcile-secrets.sh` seeds only `node-template` + `scheduler-worker` from OpenBao (L125–126) — operator/resy OpenBao seeding is CP2a.1, so a first provision proves _substrate + node-template on OpenBao_, not full multinode. A would institutionalize two permanently-drifting provisioners, exactly what the sync contract exists to kill. Option A's other premise — "install surgically onto the _existing_ candidate-a cluster" — is also dead: Derek authorized **fresh** provision (above), and the monorepo candidate-a VM was already destroyed in the post-split reprovision.

## Next Actions

- [ ] Land CP1: get [#1384](https://github.com/Cogni-DAO/cogni/pull/1384) reviewed → merge (squash). Confirm `sync-drift-detector` next run shows zero residual on graduated paths + existing Argo Apps stay Synced.
- [ ] Land node-template freeze [#66](https://github.com/Cogni-DAO/node-template/pull/66) (docs-only, should be quick).
- [ ] **CP1b** (node-template-domain PR): `nodes/node-template/.cogni/secrets-catalog.yaml` + `nodes/node-template/k8s/external-secrets/candidate-a/` — port from node-template.
- [x] **CP2a.0 — hub-runnable provisioner** (this PR, supersedes #1405): (a) bring `provision-env-vm.sh` + lib dep-chain into the hub (byte-identical to node-template); (b) fix both hub guards (G1 origin allowlist, G2 upstream-UUID owner); (c) convert `infra/k8s/overlays/candidate-a/*` vm-discovery from the hardcoded `cogni-candidate-a.vm.cognidao.org` to the bare `vm.cognidao.org` placeholder the provisioner's Phase 4c rewrites per-slot. **Why (c):** the hub overlays carried the already-scoped alias; `FORK_DOMAIN_ROOT` is mandatory (`cognidao.org`), so Phase 4c's `sed` would double-prefix it → dead service discovery. node-template's overlays already use the bare placeholder (why its canary works). Added alongside legacy `provision-test-vm.sh` — zero call-sites, zero runtime risk (overlays only reach a deploy branch via provision, which rewrites them; promote/flight only bump digests). **Needs Derek**: confirm B + a named same-day node-template porter (backflow refactor) before merge.
- [ ] **`candidate-b` is NOT the unblock** — investigated per Derek's nudge and rejected: candidate-a overlays are not a clean slot template (vm-discovery DNS, pinned digests, `test.cognidao.org` domain all candidate-a-coupled), so a blind candidate-b build inherits the same DNS corruption _plus_ unverifiable digest/domain retargeting. ASAP path is a **watched** first provision on candidate-a (down, scaffolded, on-plan), fix-forward live — not a new env.
- [ ] **CP2a.1 — catalog activation** (operator-domain): add `infra/catalog/openbao.yaml` + ApplicationSet generator entry + cloud-init bao-seed. Argo deploys nothing until this lands (the new Argo App is catalog-dormant).
- [ ] **CP2a.2 — fresh provision + validate** (Derek-triggered): `CHERRY_AUTH_TOKEN=… bash scripts/setup/provision-env-vm.sh candidate-a`; seed via `pnpm secrets:set`; then `/validate-candidate` (bao pod up, ExternalSecret SecretSynced, pod envFrom from ESO, request in Loki at SHA).
- [ ] **CP2b** preview, **CP2c** production — each after the prior env soaks. One PR per env.
- [ ] Work down [#1366](https://github.com/Cogni-DAO/cogni/issues/1366) drift queue: port flagged files hub→artifact verbatim; never re-implement.

## Risks / Gotchas

- **Single-node-scope gate**: CP2's openbao/catalog edits are operator-domain — keep node-domain (`nodes/X/`) edits in their own PRs or the gate fails. See `tests/ci-invariants/classify.ts` (RIDE_ALONG list).
- **Argo is catalog-driven**: adding `infra/k8s/argocd/openbao/` does nothing until you also add `infra/catalog/openbao.yaml` + a generator in the env ApplicationSet. This is why CP1 is safely dormant — and what CP2a must wire.
- **OpenBao unseal**: fresh provision yields a _sealed_ bao. Bootstrap must init + unseal + escrow Shamir keys off-VM (charter L5: `NO_OPERATOR_ROOT_TOKEN_ON_LAPTOP`). ✅ Confirmed: `provision-env-vm.sh` Phase 5b (5b.1 register Argo Apps → 5b.2–5b.5 init/unseal/KV-mount/auth-bind/writer-role) handles this. The hub-runnable port lands in CP2a.0.
- **Sync-contract porter**: bringing `provision-env-vm.sh` into the hub is a backflow refactor — the sync contract requires a **named same-day node-template porter** committed before merge, else `provision-env-vm.sh` drifts (🟡 different: hub guard allows `cogni`, artifact's allows forks). Cleanest: the _same_ hub-capable guard ships to node-template (it already allows forks; just also allow the hub-or-fork shape) so the file stays **shared-identical** and needs no divergence entry.
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
