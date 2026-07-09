---
work_item_id: story.5020
status: needs_implement
branch: main
last_commit: d31c20e1609f
---

# story.5020 — env-membership verb: prove it e2e on the test env

## Mission

Pickup: the node **env-membership verb** (`POST /api/v1/nodes/{id}/envs {env, present}`) is built, merged, and RBAC-proven, but has **never been proven end-to-end on a non-prod env** — because the only operator wired to a _reconciling_ monorepo is production. Your job: stand up the **test env** (`cogni-test-org/cogni-monorepo`) production-shaped so the candidate-a/preview operator's verb can open a real catalog PR there, then run the full **add → merge → reconcile → remove** loop and post a `/validate-candidate` scorecard. Do **not** repoint test operators at `cogni-dao/cogni` — test apps targeting `cogni-test-org` is deliberate isolation (`candidate/preview must not mint into Cogni-DAO`).

## Goal

A node's deploy-env membership is changed by RBAC-gated operator verb → catalog-edit PR → merge → Argo reconcile — not hand edits. **E2E validation signal:** on the test env, `POST /nodes/<test-node>/envs {env:"candidate-a", present:false}` returns `{status:"pr_opened"}` with a byte-identical diff (catalog `envs:` −env, appset file delete, kustomization fold-out, overlay dir delete), the PR passes CI (esp. `render-node-appset.sh --check` + `render-node-overlays.sh --check`), merges, and the node's Application prunes; `present:true` re-adds it. RBAC: granted principal → past-authz; ungranted → `403 authz_denied`. Guard: removing `node-template` → `422 template_node_immutable`. Loki: `dns.{forward,reverse}_reconcile.skipped` (slug+env scoped) fires per exercise.

## Start By Reading

- **Skill: `.claude/skills/manage-node-envs/SKILL.md`** — the request→owner-approve→verb→merge→verify loop (canonical).
- **Skill: `.claude/skills/test-expert/SKILL.md`** § "Environment e2e test lane" — the test-org/App contract + Pareto path (this task = step 2, make candidate/test "production-shaped").
- Verb route: `nodes/operator/app/src/app/api/v1/nodes/[id]/envs/route.ts`; writer `openNodeEnvPr` in `src/adapters/server/vcs/github-repo-write.ts`; pure planner + guard in `src/shared/node-app-scaffold/gens/env-membership-plan.ts` (`buildEnvDeltaPlan`, `TEMPLATE_NODE_IMMUTABLE`).
- Renderers (drift gates): `scripts/ci/render-node-appset.sh` (envs-aware ref) + `scripts/ci/render-node-overlays.sh` (`wizard_nodes_for_env`, fixed in #1934).
- Approve route (owner-gated): `src/app/api/v1/nodes/[id]/developers/route.ts` (`nodes.ownerUserId == session.id`).

## Current State (facts)

- **Merged to main** (`d31c20e1`): verb+UI (#1914), render-node-overlays ATOMIC_PER_ENV fix + `template_node_immutable` guard + tests (#1934), OpenBao clobber-proof (#1930), SSH-herd cap (#1927), `manage-node-envs` skill (#1931). `#1928` (idempotent runtime reconcile) open/mergeable.
- **Proven:** RBAC gate live (grant→200, deny→403); verb opens correct byte-identical PRs (verified diffs); catalog-removal → Argo prune observed on candidate-a (blue/oss/red/habitat pruned post-#1936).
- **NOT yet proven:** the single-flow verb→merge→**reconcile** on any env, because test/preview operators target `cogni-test-org/cogni-monorepo` which is **not production-shaped** — it's **missing `infra/k8s/argocd/appsets/<env>/`** → verb 404s at catalog fetch. (It already HAS: the node-template overlay template, `scripts/ci/node-applicationset.yaml.tmpl`, and both render scripts. Only the generated appsets tree + `envs:` lines are missing.)
- **Env builds (stale):** prod `cfc15e77` (6 behind main, guard NOT live), preview `fbcee197`, candidate-a `556e2e2a` (2026-05-12, ~2mo — regressed post-incident; a `candidate-flight` of main HEAD failed at `decide`). Bootstrap prod OpenFGA has `env_manager`.
- **RBAC grants (principal `fb0b740d`):** `env_manager` approved on prod `node-template` (template — un-toggleable) + pending on prod `games`/`beacon`. You'll grant on a **test-org** node instead.
- Access: you have `push` on both `cogni-dao/cogni` and `cogni-test-org/cogni-monorepo` (verified).

## Design / Implementation Target

1. **Stand up `cogni-test-org/cogni-monorepo` production-shaped** (respect isolation — do NOT repoint operators): add `envs:` lines to its deployable catalog rows (e.g. `test-cog`), then run `scripts/ci/render-node-appset.sh --write` + `render-node-overlays.sh --write` _against that repo's catalog_ to generate the appsets tree + overlays; open a PR through its flow. The scripts + template already live there, so this is generate-and-commit, not hand-authoring.
2. **Get env_manager legitimately** on a test-org node: `POST /nodes/<node>/access-requests {role:"env_manager"}` → **owner approves** via `/developers` (Derek — env_manager is approved, ping him for the specific node). NEVER write OpenFGA tuples directly / self-approve / use kube — that was an earlier misstep, do not repeat.
3. **Run the loop + post `/validate-candidate`** (skill: `validate-candidate`): remove→PR→merge→prune, add→PR→merge→redeploy, RBAC deny, guard 422, idempotent no_changes, Loki. Must-not-regress: byte-identity between verb output and the bash renderers.
4. **Boundary:** the verb is `(node, env)` grain only; test operators stay pinned to `cogni-test-org`; no prod promote to prove this (prove on test).

## Next Actions / Risks

- [ ] Stand up the test monorepo (Target 1) — the one gating step; delta is small + scoped above.
- [ ] Request+get env_manager on a test-org node (Target 2) — **blocked on Derek's owner-approval; ping him**.
- [ ] Run the loop + post the scorecard (Target 3).
- [ ] Optional: promote main→prod so the `template_node_immutable` guard is live (prod `cfc15e77` predates it — a raw remove of node-template currently opens a PR instead of 422).
- **Gotchas:** `node-template` is the per-env overlay TEMPLATE every node clones — never remove it from an env (guard blocks it; it self-destructs the env's renders). `cogni-test-org` is NOT wired to a live cluster ("not reflected in any deployment" — a known shortcoming) so a test-repo merge may not visibly reconcile pods; if so, the reconcile is proven separately (candidate-a prune obs) and the test env proves verb authorship + CI-mergeability. **deploy-infra** reapply is the dangerous lever (restart-storm + secret-clobber → prod outage this cycle; task.5049/bug.5068) — never run it casually against prod. Prod kube is heal-only.
- Related work items: story.5013 / PR #1829 (fleet VM-health dashboard — different dev); bug.5071/5072 (candidate-a memory kill); task.5069 (founder→admin RBAC at node-wizard publish).
