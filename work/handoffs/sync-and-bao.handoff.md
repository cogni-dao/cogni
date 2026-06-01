---
id: sync-and-bao.handoff
type: handoff
work_item_id: proj.repo-sync
status: active
created: 2026-05-31
updated: 2026-05-31
branch: (multiple — see In-Flight)
last_owner: derek-claude
---

# Handoff: drive the monorepo to (A) OpenBao secrets cutover + (B) node-template 1-1 sync

## Two outcomes you own

- **A — OpenBao cutover on the monorepo.** The OpenBao + ESO substrate is staged but **inert**. Drive it to: operator (then every node) reads its secrets from an ESO-synced `<node>-env-secrets` (sourced from OpenBao), the old sops `.enc.yaml` + inline `SECRETS[71]` are retired, and it's **proven on candidate-a**.
- **B — node-template artifact reaches 1-1 (drift detector → 0).** `Cogni-DAO/node-template` (public template) byte-matches the hub for everything outside declared divergences.

The drift dashboard is the auto-generated [sync-drift issue #1366](https://github.com/Cogni-DAO/cogni/issues/1366). The contract is [`docs/spec/repo-sync-contract.md`](../../docs/spec/repo-sync-contract.md). Run the detector locally: `HUB_REF=origin/main node scripts/ci/detect-sync-drift.mjs` (needs `yq` + the `yaml` pkg; clones the artifact to /tmp — no `pnpm install`).

## Current state (2026-05-31)

Drift **446 → ~178** this session. Merged: dolt/knowledge substrate port (node-template#70), hub-prod-secrets omit (#1401), knowledge skills (#71), docs (#72), scheduler-worker-is-shared-service SSOT (#1392), node-template preview+prod overlays (#1394), `create-node.md` guide (#1396); hub: #1377 (dolt), #1384 (bao base), #1386 (AGENTS.md).

In-flight: **#1402** (hub — catalog-driven `build_target`, task.5079; **dev-approved + deploy_verified on candidate-a**, merge-queued) and **node-template#73** (the build_target backflow). **#1388** (bao CP1b) is OPEN with manifest conflicts (from #1401 — trivial rebase, secrets dev owns).

## Track A — OpenBao cutover

The substrate (#1384 base, #1388 CP1b) only **stages** OpenBao + ESO Argo Apps + the catalog loader. Both are **no-op flights today** (zero `nodes/*/app/` surface, inert until the loader is wired) — do **not** waste a candidate-a flight on them.

**🚩 The candidate-a flight + `/validate-candidate` is REQUIRED at the loader-cutover slice** — the first time a node boots reading from the ESO-synced secret instead of the old path. That validation MUST prove: OpenBao App **Healthy** · external-secrets App **Healthy** · the node's ExternalSecret `status: SecretSynced` · the node app boots with secrets present (not crashlooping on missing env). This is the first non-no-op bao flight — raise it loudly.

**Aligning the old operator secrets into bao** (the "Compose→OpenBao migration", per `docs/spec/secrets-classification.md`):

1. **Classify** each operator secret into a tier (A1/A2/B/D/E/F/G) in `infra/secrets-catalog.yaml` (operator-domain).
2. **Load** the OpenBao-routed ones into the vault at `cogni/<env>/operator/<KEY>`.
3. **Wire** operator's ExternalSecret (`dataFrom: extract` → `operator-env-secrets`).
4. **Flip** operator's Deployment to consume `operator-env-secrets` (ESO-managed).
5. **Validate** on candidate-a (the flight above).
6. **Retire** the old inline `SECRETS[71]` in `scripts/setup-secrets.ts` + the sops `infra/k8s/secrets/{prod,staging}/*.enc.yaml` (already `omit_from_artifact` per #1401).

The heavy slice is the `setup-secrets.ts` loader refactor ("wire the dead loader; remove inline SECRETS") in #1388's backlog. **Coordinate with the #1388 owner** — don't fork their work; co-own the cutover + own the validation harness.

## Track B — node-template 1-1 sync

The remaining ~178 drift is dominated by the **forked CI/CD pipeline**: `scripts/ci` (22🟡), `.github/workflows` (7🟡), `infra/k8s` (14🟡). This is bug.5001 at scale.

**THE PATTERN THAT ACTUALLY KILLS DRIFT (proven, task.5079):** make the scripts **catalog-driven** so the _same_ file runs on hub (N targets) and template (M targets) → byte-identical → that drift collapses **at the source**, permanently. Reconciling forked copies by hand just narrows it and it re-forks on the next PR. #1402 did this for `build_target`; #73 backflowed it.

Drain order:

1. **Finish `build-and-push-images.sh` convergence** — #1402 + #73 unify `build_target`, but **61 lines still differ**: node-template has `build_migrator_target()` + `resolve_migrator_tag()` (builds migrator images) that the **hub lacks**. **Backflow that migrator support INTO the hub** (hub PR) → file fully converges → 🟡 clears.
2. **Catalog-drive the next CI scripts** (same pattern): `detect-affected.sh`, `resolve-pr-build-images.sh`, then the `ci.yaml` single-node-scope filter (⚠️ workflow file — quarantine risk; squash to one commit if checks don't fire).
3. **Declare hub-only paths `omit_from_artifact`** (manifest PR): operator/resy k8s overlays, `.env.operator.example`, hub-internal `work/handoffs/*`, `nodes/node-template/.cogni/repo-spec.yaml` (fork identity, intentionally divergent).
4. **#1388-gated bao 🟣 cluster** (loader, ESO scope, `secrets-catalog-loader.ts`) reconciles when #1388 lands.

## Hard-won lessons (do not relearn)

- **NEVER big-bang port.** The dolt port (node-template#70) took **10 CI rounds** because "node-template drift" is ~50 coupled upstream PRs tangled across shared files (auth.ts, server-env.ts, config). Port **per-upstream-PR**, scoped to one subsystem. Excising features mid-port re-mixes hub/artifact versions of coupled files and _creates_ breaks — match the upstream PR's boundary instead.
- **Hub root configs leak the hub node-set.** `package.json` (operator/resy scripts), `tsconfig.json` (operator project refs + `@/*` aliases), `pnpm-lock.yaml` (operator/resy workspace members) **cannot be ported verbatim** — reconcile to the artifact's node set + **regenerate the lockfile** (`pnpm install --lockfile-only`, ~10s, allowed).
- **The artifact's gates are stricter:** `check:docs`, dep-cruiser layer rules, biome `ui-governance/token-classname-patterns` (hardcoded `ring-1` → `ring-[var(--ring-width-sm)]`). Ported hub code fails artifact-specific rules — fix file-scoped.
- **Prefer catalog-driven refactors over reconciling forks** — they delete the fork _mechanism_.
- **No heavy local suites** (Derek's machine). `git push --no-verify`; CI is verification. `check-jsonschema --schemafile .cogni/sync-manifest.schema.json .cogni/sync-manifest.yaml` IS safe + required before every manifest push.
- **Manifest PRs serialize.** `.cogni/sync-manifest.yaml` edits conflict; expect rebases (e.g. #1401 ↔ #1388). Land one, rebase the next.

## Pointers

| Resource                                                        | Why                                             |
| --------------------------------------------------------------- | ----------------------------------------------- |
| [#1366](https://github.com/Cogni-DAO/cogni/issues/1366)         | live drift dashboard                            |
| `scripts/ci/detect-sync-drift.mjs`                              | the detector — truth                            |
| `.cogni/sync-manifest.yaml` + `.schema.json`                    | the SSOT you edit; check-jsonschema gate        |
| `work/projects/proj.repo-sync.md`                               | owning roadmap (S0–S5)                          |
| `docs/spec/secrets-management.md` + `secrets-classification.md` | the OpenBao + ESO contract + tier rules         |
| `.claude/skills/validate-candidate`                             | bao cutover validation flow                     |
| `.claude/skills/devops-expert`                                  | CI/CD reviewer lens; sync-contract ground truth |
| #1402 / node-template#73                                        | the catalog-driven pattern to replicate         |
