---
id: story.5009.handoff
type: handoff
work_item_id: story.5009
status: active
created: 2026-06-18
updated: 2026-06-18
branch: "(new — branch off origin/main in a fresh worktree)"
last_commit: 1bb384b756
---

# Handoff: First-class operator + node-template nodes → RBAC agents run flight/secrets/sync (deprecate personal `gh`)

## Mission

New mission: make `operator` and `node-template` **first-class nodes** in the production operator app's registry, so an **RBAC-gated agent** (not a human's personal GitHub account) can run flight, secrets management, and the node-template→fork sync against them. This is the strategic core of "operator as agentic git-manager": today every privileged action still rides the maintainer's `gh` actor; the goal is that an authenticated agent, granted an OpenFGA role on a node, does it. **You own this E2E.** Scrutinize the proposed path below, disagree where warranted, agree on the approach, then implement — don't treat the design as fixed.

## Goal

- `operator` and `node-template` exist as rows in the `nodes` table (identity + ownership) and as OpenFGA `node:` objects with a seeded `admin` tuple.
- A human (you/Derek) can grant an **agent** `developer` / `production_promoter` / `secrets_manager` on those nodes via `POST /api/v1/nodes/{id}/developers`.
- **E2E validation signal:** that agent — authenticating with its own API key, **no personal `gh`** — successfully calls `POST /api/v1/vcs/flight` and `POST /api/v1/nodes/{id}/secrets` for `operator`/`node-template` and the action is **authorized by OpenFGA** (not `authz_denied`, not 404-not-in-table). Read the agent's own request back from Loki at the deployed SHA.
- **Candidate-a flight proof:** flight the implementing PR via `candidate-flight.yml`, confirm `https://test.cognidao.org/version.buildSha` == PR head SHA, then exercise the new registration + an RBAC-gated flight as the agent against `test.cognidao.org`, and post a `/validate-candidate` scorecard on the PR. Then merge → preview → prod promote (operator owner-approve).
- **Must not regress:** catalog (`infra/catalog/*.yaml`) stays the deploy SSOT; the DB row is identity/ownership/RBAC-anchor only. `node-preview-promote` must not start double-firing for operator (its monorepo) or node-template.

## Start By Reading

- This handoff, then the **recon already done** (summarized in Current State below — it has exact file:line).
- `infra/openfga/rbac-model.json` (~L73–177) — the `node` object: `admin → developer/secrets_manager/production_promoter → can_flight/can_manage_secrets/can_promote_production`. **The model is already complete; you are not designing RBAC.**
- `nodes/operator/app/src/shared/db/nodes.ts` (L44–92) — the `nodes` schema + the `NODES_TABLE_SCOPE` docstring (L8–9) that currently _excludes_ operator/node-template.
- `nodes/operator/app/src/app/api/v1/nodes/route.ts` (L76–187) — the only insert path (wizard; `status=dao_pending`, `ownerUserId=session`); **note it never seeds an OpenFGA tuple**.
- `nodes/operator/app/src/app/api/v1/nodes/[id]/developers/route.ts` (L207–233) — the grant flow (writes `developer`/`production_promoter` tuples).
- The action routes that gate by node-id from the table: `app/api/v1/vcs/flight/route.ts` (`node.flight`, node lookup ~L271), `app/api/v1/deploy/promote/route.ts` (`node.promote_production`), `app/api/v1/nodes/[id]/secrets/route.ts` (`node.manage_secrets`).
- Skills: `rbac-expert`, `node-self-serve-secrets`, `cicd-agent-playbook`. Specs: `docs/spec/rbac.md`, `docs/spec/node-ci-cd-contract.md` (node identity/contract), `docs/spec/node-baas-architecture.md`.

## Current State

- **Shipped + live in prod** (context, not your scope): node-template→fork sync — PR #1681 (feature) + #1750 (one-living-PR-per-fork rework). Prod serves `f1334cb`. Fires on every node-template merge; opens `cogni-operator/node-template-{sync,upstream}` PRs on forks. `work item task.5020` (done).
- **The two gaps this story closes (recon-confirmed):**
  1. operator + node-template are **not in the `nodes` table** (wizard-only insert; no "register existing repo" path) → every node-scoped route 404s for them.
  2. node creation **never seeds the owner→admin OpenFGA tuple** → even a node _owner_ gets `authz_denied` until `/developers` is hit. **Latent bug for existing wizard nodes too.**
- **Rails already exist:** OpenFGA `node` model complete; flight/secrets/promote already authz-gate by node-id. So this is _plumbing two gaps_, not new RBAC.
- Branch: none yet — start fresh off `origin/main`. No code written for this story.

## Design / Implementation Target

_Proposed — ratify or revise before building._

1. **Slice 1 (foundation, low-risk): seed the `admin` tuple on node creation.** `POST /api/v1/nodes` writes `user:<ownerUserId> admin node:<id>` after insert. Fixes authz_denied-for-owners for **all** nodes. Isolated PR + test.
2. **Slice 2: register existing repos as first-class nodes.** An idempotent registration path (admin endpoint or bootstrap) inserting rows for `operator` (`Cogni-DAO/cogni`) + `node-template` (`Cogni-DAO/node-template`), `status=active`, each seeding its `admin` tuple. Update the `NODES_TABLE_SCOPE` docstring.
3. **Boundary:** catalog remains deploy SSOT; DB row = identity + ownership + RBAC anchor only. Do **not** make the registry the source for image/port/dockerfile.
4. **Guard:** `node-preview-promote.server.ts` resolves by `nodes.slug === ctx.repo`; ensure registering node-template doesn't trigger spurious preview-promotes (operator's PRs land in repo `cogni` ≠ slug `operator`, so likely safe — **verify**, and decide node-template's behavior explicitly).
5. **Open decision for you + Derek:** `ownerUserId` for operator + node-template = **Derek's user** (recommended — he owns both, then delegates to agents) vs a **system principal** (`COGNI_SYSTEM_PRINCIPAL_USER_ID` exists). Agree before Slice 2.
6. **Strict typing, Zod boundaries, OpenFGA via `AuthorizationPort`** (no direct tuple writes outside the adapter). No new deploy-brain (freeze policy).

## Next Actions / Risks

- [ ] Read the recon files above; confirm the two gaps + the OpenFGA model are as described.
- [ ] **Decide `ownerUserId`** (Derek's user vs system principal) — blocks Slice 2.
- [ ] Build Slice 1 (admin-tuple-on-create) + test; flight + `/validate-candidate` on candidate-a.
- [ ] Build Slice 2 (register operator + node-template) + guard node-preview-promote; validate.
- [ ] Prove the E2E: grant an agent a role, have it flight/secrets via API (no `gh`), read it back from Loki.
- [ ] Then it unblocks the **related thread**: node-template→operator-app sync (operator as a real RBAC node) — separate work item.
- Risk: catalog vs DB dual-source — keep DB identity-only or you create two SSOTs.
- Risk: registering operator could let `node-preview-promote`/flight treat the hub monorepo as a deployable node — guard + verify.
- Gotcha: `/api/v1/nodes` GET is RLS owner-scoped → returns 0 unless you own the row; don't read that as "registration failed."
- Gotcha: candidate-a App must be installed + (for any push-triggered piece) subscribed to events — see `reference_candidate_app_no_push_webhook` lineage.

## Pointers

| File / Resource                                                                                    | Why it matters                                               |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `infra/openfga/rbac-model.json`                                                                    | The `node` RBAC model (already complete)                     |
| `nodes/operator/app/src/shared/db/nodes.ts`                                                        | `nodes` schema + `NODES_TABLE_SCOPE` invariant to change     |
| `nodes/operator/app/src/app/api/v1/nodes/route.ts`                                                 | Insert path; where to seed the admin tuple                   |
| `.../api/v1/nodes/[id]/developers/route.ts`                                                        | Agent grant flow (the tuple-write reference)                 |
| `.../api/v1/vcs/flight/route.ts`, `.../deploy/promote/route.ts`, `.../nodes/[id]/secrets/route.ts` | Node-scoped, RBAC-gated action routes (the agent's surfaces) |
| `nodes/operator/app/src/app/_facades/deploy/node-preview-promote.server.ts`                        | Slug-resolution to guard against double-fire                 |
| skills `rbac-expert`, `node-self-serve-secrets`, `cicd-agent-playbook`                             | RBAC + secrets + agent flight playbooks                      |
