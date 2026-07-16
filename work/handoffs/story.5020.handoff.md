---
work_item_id: story.5020
status: needs_implement
branch: docs/skill-node-to-candidate-a
last_commit: ad4ed493df
---

# story.5020 — env-membership verb: close the prod e2e (real pods)

## Mission

Pickup: the **env-membership verb** (`POST /api/v1/nodes/{id}/envs {env, present}`) is **built, merged, and proven** for authorship + CI byte-identity + RBAC + guard + idempotent + Loki (on candidate-a + test-org). What is NOT done is the **terminal proof**: an agent (or human) toggles a node's `production` env and **real pods start/stop on a live cluster**, ending at an `agent-api-validation` endpoint. This session disproved the prior handoff's assumptions — read **Current State** carefully; the path is now narrow and gated on **two concrete things**, not a fan-out of subagents.

## Goal

A node's deploy-env membership is changed by the RBAC-gated verb → catalog PR → merge → **Argo auto-reconcile → pods actually start/stop** → live endpoint answers. Derek's bar: _a fresh agent with only a 1-sentence pointer + RBAC auth drives a node from nothing → deployed → `agent-api-validation`, unaided._

**E2E validation signal — TWO gates block it (both proven this session):**

1. **task.5072 — the verb is session-only.** `route.ts` auths via `getSessionUser()`; there is **no agent-bearer path**. A prod bearer key gets **401** on the verb (verified: `POST https://cognidao.org/api/v1/nodes/{id}/envs` → 401, route present). So a "fresh agent with RBAC" **cannot call the verb today** — the bar is unreachable until task.5072 adds a bearer + `node.manage_envs` path (like `/vcs/merge`). A **human in a browser CAN** drive it now.
2. **A live-deployable env.** **prod (`cognidao.org`) is READY for a browser-driven test** — `/nodes` = 200 live, verb route present, operator healthy on `cfc15e77` (#1914). **candidate-a is capacity-dead** — flight [29463391487](https://github.com/cogni-dao/cogni/actions/runs/29463391487) FAILED at `verify-candidate` (`newRsAvailable=0` for 600s — new ReplicaSet can't schedule on the over-subscribed 5.8G box, bug.5071); it serves the 2-month May build `556e2e2a`, `/nodes` → 404. **Do not use candidate-a until bug.5071 right-sizes the box.**

**Proof shape when unblocked** (use the `node-to-candidate-a` skill's diagram, not ad-hoc): granted principal → verb `200`; PR is byte-identical 4-file diff; merge → `cogni-production-<slug>` Argo Application Healthy + live endpoint; `present:false` prunes it (pods gone); guard: `node-template` → `422 template_node_immutable`; idempotent → `no_changes`; Loki `dns.{forward,reverse}_reconcile.skipped {slug, env}`.

## Start By Reading

- **Skill `node-to-candidate-a`** (`.claude/skills/node-to-candidate-a/SKILL.md`, merged #1941) — the cold-start runbook + the **merge-gated / deploy-automatic** mental model + the e2e diagram. Its hub twin: knowledge contribution **`contrib-…6b741270`** (open, needs owner admin-merge — this is the "watch it deploy" workflow Derek means; don't reinvent it).
- **`.claude/skills/manage-node-envs/SKILL.md`** — the verb loop (request→approve→verb→merge→verify).
- Verb: `nodes/operator/app/src/app/api/v1/nodes/[id]/envs/route.ts` (**note the `getSessionUser()` call — this is task.5072**); writer `openNodeEnvPr` in `src/adapters/server/vcs/github-repo-write.ts`; planner + `TEMPLATE_NODE_IMMUTABLE` guard in `src/shared/node-app-scaffold/gens/env-membership{,.plan}.ts`.
- **task.5072** (session→bearer) · **bug.5071** (candidate-a capacity) · **bug.5072** (intermittent OpenFGA `authz_unavailable`) · **bug.5073** (verb newline strip — FIXED #1940).
- Node deploy-topology spec: hub contribution **`contrib-…6b78d593`** (open, admin-merge).

## Current State (facts, verified this session 2026-07-16)

- **main** = `d1e52863` (#1941 — **docs-only**, no operator image). **candidate-a** = `556e2e2a` (May build, capacity-dead). **preview** = `69ba8fd7` (#1937). **prod** = `cfc15e77` (#1914).
- **Merged to main:** verb #1914 · bug.5073 fix #1940 (verb writes clean `]\n`) · decommission #1937 (blue/oss/red/habitat/games removed all envs) · test-expert ref #1939 · skill #1941 · candidate right-size #1936 · SSH-herd cap #1927.
- **Verb PROVEN** (candidate-a / test-org `anotha`): RBAC `403→200`, byte-exact 4-file PR ([test-org#48](https://github.com/cogni-test-org/cogni-monorepo/pull/48) merged remove; [#50](https://github.com/cogni-test-org/cogni-monorepo/pull/50) add mergeable), drift-gate byte-identity, Loki fwd+rev, idempotent `no_changes`, bug.5073 fix verified live. **Real-pod REMOVE** proven separately via #1936 (candidate-a Argo prune). The unproven atom is **ADD → pods start → endpoint** on a live env.
- **Prod promote is NOT "green-but-dead" (my earlier error).** Promoting `d1e52863` no-op'd **correctly** — it's docs-only, no image (`promote-k8s` skipped: `Image not found: …:sha-d1e52863`). The **correct** target to ship the bug.5073 fix to prod is **`63af53d` (#1940)**, which HAS an operator image (candidate-a ran it). This is optional — the fix only affects verb-PR formatting (patchable), not deploy.
- **Derek owns ~40 throwaway cogni-dao nodes** (owner-scoped; invisible to agent bearer keys → `GET /api/v1/nodes` returns 0 for an agent). **No new node needs birthing** — node-formation is wallet-gated (browser + 2 on-chain DAO TXs, no agent path) and unnecessary. Pick one of Derek's existing throwaways.
- Closed [#1926](https://github.com/cogni-dao/cogni/pull/1926) (stale decommission dupe, superseded by merged #1937).

## Design / Implementation Target

1. **[the real unblock] task.5072 — give the verb a bearer path.** Add agent-bearer auth + a `node.manage_envs` RBAC check to `envs/route.ts` (mirror `/api/v1/vcs/merge`, which is bearer + RBAC). This is what makes Derek's "fresh agent with RBAC" bar _reachable_ — without it the e2e is browser-only forever.
2. **[the proof] run the prod ADD→deploy→endpoint→remove cycle** on ONE of Derek's throwaway nodes, driven either by the browser (works today) or by an agent (after Req 1). Prove real pods via the Argo Application + a live endpoint + `agent-api-validation`, per the `node-to-candidate-a` skill.
3. **[optional] promote `63af53d` (#1940) → production** to ship the bug.5073 fix (operator-only, image exists, no substrate mutation). Trust `https://cognidao.org/version` `.buildSha`, not the workflow conclusion.
4. **Boundaries / must-not-regress:** verb grain = `(node, env)` only; CATALOG_IS_SSOT (never hand-edit overlays/appsets — selfHeal reverts); merge is gated, deploy is automatic; `env_manager` = request→owner-approve ONLY (no tuples/self-approve/kube); ATOMIC_PER_ENV; verb output stays byte-identical to `render-node-{appset,overlays}.sh`.

## Next Actions / Risks

- [ ] **Implement task.5072** (verb bearer + `node.manage_envs`) — the single highest-leverage move; without it the "fresh agent" bar is unreachable and this loops forever.
- [ ] **Run the prod proof** on a Derek-owned throwaway node (browser now, or agent after task.5072). Needs `env_manager` on that node — **request→owner-approve (Derek) is the only path**; surface the approve URL, never self-grant/tuple/kube.
- [ ] **bug.5071**: candidate-a can't roll ANY new build until the box is right-sized (or load shed further). It is NOT a viable proving ground meanwhile.
- [ ] Owner-only: merge hub guide `contrib-…6b741270` + spec `contrib-…6b78d593`; merge/close cosmetic test-org#50.
- **Gotchas:** `/version` is the only deploy truth (workflows no-op silently on docs-only shas). `env_manager` grant is per-operator-store (a prod grant ≠ candidate-a grant). OpenFGA flaps `authz_unavailable` (retry, bug.5072). Verb PRs open on `cogni-dao/cogni` (prod nodes) or `cogni-test-org/cogni-monorepo` (test-org, never get VMs); merge via `POST /api/v1/vcs/merge {nodeId, prNumber}`.
