---
work_item_id: story.5020
status: needs_implement
branch: docs/skill-node-to-candidate-a
last_commit: 999a72313d
---

# story.5020 — env-membership verb: see it through E2E on PROD

## Mission
Pickup: the **env-membership verb** (`POST /api/v1/nodes/{id}/envs {env, present}`) — RBAC-gated, catalog-authored control of a node's deploy topology — is **built, merged, and proven end-to-end on candidate-a**. It is **NOT yet proven on prod with real pod movement**, and prod runs a stale, pre-fix build. You are the **dev-manager**: hold this one outcome and drive it to prod-proven by coordinating two subagents against non-overlapping tasks — **`/devops-expert`** (unstick the prod promote so the fix ships) and **`/node-wizard-expert`** (stand up one disposable deployable node so the verb can move real pods). Derek is AFK; do not bounce back for anything you can resolve.

## Goal
A node's deploy-env membership is changed by the RBAC-gated verb → catalog PR → merge → **Argo auto-reconcile → pods actually start/stop on the prod cluster** — proven, not asserted.

**E2E validation signal (on prod):**
1. `curl https://cognidao.org/version` → `.buildSha` == current `origin/main` (the bug.5073 fix `63af53d` and later are live). Today it is `cfc15e77` (#1914, 2026-07-02) — the verb is present but pre-fix (strips the catalog trailing newline).
2. With `env_manager` on a **disposable cogni-dao node**, `POST /nodes/<node>/envs {env:"production", present:true}` → `{status:"pr_opened"}` with a **byte-identical 4-file diff**; the PR passes CI **without a manual newline patch** (proves #1940 live), merges, and the prod `cogni-production-<slug>` Argo Application appears Healthy with a live endpoint; `present:false` prunes it (pods gone).
3. RBAC: granted principal → past-authz; ungranted → `403 authz_denied`. Guard: removing `node-template` → `422 template_node_immutable`. Idempotent: already-holding → `no_changes`, no PR. Loki: `dns.{forward,reverse}_reconcile.skipped {slug, env}` per exercise.

Candidate-a already shows (1)+(2 minus prod)+(3) — reuse that as the template. **Boundary:** cogni-test-org nodes (anotha/test-cog) NEVER get VMs (by design) — they prove verb authorship + CI byte-identity only. Real pods require a **cogni-dao** node on a live cluster.

## Start By Reading
- **Skill `node-to-candidate-a`** (`.claude/skills/node-to-candidate-a/SKILL.md`) — the cold-start runbook + the merge-gated/deploy-automatic mental model. Its hub twin: knowledge contribution `contrib-…6b741270` (open, needs owner admin-merge).
- **`.claude/skills/manage-node-envs/SKILL.md`** — the canonical verb loop (request→approve→verb→merge→verify).
- Verb: `nodes/operator/app/src/app/api/v1/nodes/[id]/envs/route.ts`; writer `openNodeEnvPr` in `src/adapters/server/vcs/github-repo-write.ts`; pure planner + `TEMPLATE_NODE_IMMUTABLE` guard + `setCatalogEnvs` in `src/shared/node-app-scaffold/gens/env-membership{,.plan}.ts` + `env-membership.ts`.
- **`/promote` skill** — production promote args + the "trust `/version.buildSha`, not the workflow" rule.
- **bug.5071** (candidate-a capacity/ESO substrate kill) + **bug.5072** (intermittent OpenFGA `authz_unavailable`) — the prod promote failed in the SAME `node-substrate` lane; read these first.

## Current State (facts)
- **Merged to main** (`d1e52863` at handoff): verb #1914; **bug.5073 fix #1940** (verb no longer strips the catalog trailing newline — the whole `unit` job incl. drift gates used to skip); decommission #1937 (blue/oss/red/habitat/games removed all envs); skill #1941; test-org shaping test-org#47.
- **candidate-a** operator = `63af53d` (fix live), **3 commits behind main**. **Prod** = `cfc15e77` (#1914, pre-fix). **Preview** = `69ba8fd7`.
- **Proven on candidate-a / test-org `anotha`:** RBAC `403→200`, byte-exact 4-file PR (test-org#48 remove, #50 add — open in queue), `render-node-{appset,overlays}.sh --check` drift gates green (verb == bash renderers), Loki fwd+rev events, idempotent `no_changes`. bug.5073 fix verified live (verb writes clean `]\n`).
- **BLOCKED:** the **2026-07-10 prod promote (`promote-and-deploy.yml`) FAILED at `node-substrate` (node-template/beacon/poly)** and has not been retried. So the fix is not on prod. No prod pod-movement proof exists.
- **No disposable cogni-dao node left** (decommission cleared them); `node-template` is guard-immutable → cannot cycle. This is why a new deployable node is needed for the real proof.

## Design / Implementation Target
1. **[devops-expert task] Unstick + land the prod promote.** Diagnose the `node-substrate` failure (materialize→reconcile SSH lane — suspect ESO webhook / node-capacity, same class as bug.5071; read the run + Loki, do NOT SSH prod). Get `cognidao.org/version.buildSha` to match `origin/main`. Do not run `deploy-infra.sh` casually (task.5049/bug.5068 outage lever). Verify via `/version`, not workflow conclusion.
2. **[node-wizard-expert task] Stand up ONE disposable cogni-dao node** (node-formation) as the standing prod-e2e probe — off candidate-a/prod initially, real image flightable, so the verb can add→deploy→undeploy it with real pods + a live endpoint for agent-api-validation. Must NOT be user-facing.
3. **[dev-manager] Run the prod E2E** and post a `/validate-candidate`-style scorecard: authz flip, byte-identical PR (no manual patch = #1940 proven on prod), merge, Argo prune/redeploy, endpoint, `422` guard on node-template, idempotent, Loki.
4. **Boundaries / must-not-regress:** verb is `(node, env)` grain only; CATALOG_IS_SSOT (never hand-edit overlays/appsets — selfHeal reverts); merge is gated, deploy is automatic; request→owner-approve is the ONLY env_manager path (no tuples/self-approve/kube); ATOMIC_PER_ENV; the verb's output must stay byte-identical to `render-node-{appset,overlays}.sh`.

## Next Actions / Risks
- [ ] devops-expert: root-cause + re-drive the prod promote → `/version` == main. (Blocked-on-human only if it needs a prod substrate/secret action Derek must approve — say so, don't loop.)
- [ ] node-wizard-expert: form a disposable cogni-dao probe node; get `env_manager` on it (request → **owner (Derek) approves** — this is the one human gate; surface it, don't self-grant).
- [ ] dev-manager: run the prod add→deploy→remove cycle + guard/idempotent/RBAC/Loki; post the scorecard.
- [ ] Owner-only: merge the hub guide contribution `contrib-…6b741270`; merge test-org#50 (cosmetic).
- **Gotchas:** prod `/version` is the only deploy truth (workflow can lie). `env_manager` grant is per-operator-store — a prod-node grant is NOT a candidate-a grant. OpenFGA flaps `authz_unavailable` intermittently (retry). The verb PR opens on the operator monorepo (`cogni-dao/cogni` for prod nodes; `cogni-test-org/cogni-monorepo` for test-org) — merge via `POST /api/v1/vcs/merge {nodeId, prNumber}` (enqueues; poll to MERGED).
