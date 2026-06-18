---
id: design.node-self-serve-secrets-validation-roadmap
type: design
title: "Node Self-Serve Secrets — Layered Validation Roadmap"
status: draft
created: 2026-06-15
skills:
  - ../../.claude/skills/cicd-secrets-expert/SKILL.md
  - ../../.claude/skills/rbac-expert/SKILL.md
related:
  - ./node-self-serve-secrets.md
  - ./node-wizard-secret-setting.md
---

# Node Self-Serve Secrets — Layered Validation Roadmap

The bar: a node owner, holding only an API key (no kubeconfig, no vault token,
**no Derek credentials**), grants an agent secrets authority through the
**deployed** operator app; the agent writes a throwaway secret value; the value
lands in the node's running pod. This roadmap defines the validation layers and
the work each requires — so "proper e2e" is reached deliberately, not claimed.

## Capability decision (locked) — least-privilege, distinct role

Top-0.1% practice, and the pattern prod **already** ships (Agents UI shows
"Flight" for `developer` vs "Promote to production" for `production_promoter` as
**separate** grants): **one distinct, least-privilege role per capability.**

So `can_manage_secrets` computes from its **own** `secrets_manager` role
(mirroring `production_promoter`), **not** from `developer`. A node owner grants
"Manage secrets" explicitly and legibly — it is never bundled into a "Flight"
grant. (Reverses an earlier wrong assumption that secrets rode `developer`.)

Node roles → capabilities: `developer → can_flight` · `secrets_manager →
can_manage_secrets` · `production_promoter → can_promote_production`. `admin`
confers all three (union).

## Parity gaps vs flight/promote (the work)

The authz slice is wired (route `node.manage_secrets` → `can_manage_secrets`,
fail-closed 503/403; OpenFGA relation; adapter). What is **not** at parity:

| ID        | Gap                                                                                                                                                                                                     | Fix                                                                                                                                                    | Anchor                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **G1** ✅ | Secrets had no distinct grant — rode `developer`, surfaced only as "Flight"                                                                                                                             | **DONE:** `secrets_manager` role (OpenFGA model + `NODE_ACCESS_ROLES` + CHECK migration `0036`) + `ROLE_CAPABILITY.secrets_manager = "Manage secrets"` | `rbac-model.json`, `node-access-requests.ts`, `NodeAccess.tsx`     |
| **G2** ✅ | `NODE_SECRETS_ALLOWLIST` was `{}` — blocked **every** write at Gate 2                                                                                                                                   | **DONE (#1721):** Gate 2 inverted to a **denylist** — node owns its namespace; any non-reserved key allowed (`node-secrets-reserved.data.ts`, `SUBSTRATE_RESERVED_KEYS` + OpenBao `_system`/`_shared` deny). No per-node allowlist upkeep — beacon needs no catalog edit. | `node-secrets-reserved.data.ts`                                    |
| **G3**    | `<env>-node-secrets-writer` OpenBao role is provisioned **only** by `provision-env.yml` (`reconcile-env-substrate.sh:138`), NOT the routine infra lever → operator pod can't self-login → Gate 3 throws | Provision the role from the routine infra lever (`candidate-flight-infra`/`deploy-infra`) so flight-infra is **1-1 DRY** with it. **THE remaining keystone.**                       | `reconcile-env-substrate.sh:138-152`, `candidate-flight-infra.yml` |

No `secret-set.yml` workflow is needed — the write is a synchronous API call
(unlike promote's async lane). That is parity, not a gap.

## The env-axis constraint (READ THIS — it reshapes "proper e2e")

The write env is **operator-stamped, never from the body** (security):

```
route.ts:213   const deployEnv = env.DEPLOY_ENVIRONMENT;   // the OPERATOR's env
adapter.ts:60  const path = `cogni/${input.env}/${input.nodeSlug}/${input.key}`;
```

So a **prod** operator writes `cogni/production/<node>/*`; a **candidate-a** node
reads `cogni/candidate-a/<node>/*`. **These paths never intersect.** The proposed
"prod operator writes a secret that appears in the node's _candidate-a_ flight"
is **architecturally impossible** as stated. A coherent e2e must be **single-env**:
the operator's env == the node's deploy env.

Three coherent targets (pick one — gates L3):

- **(A) All-on-candidate-a** — operator + node both on candidate-a. Achievable
  after G2+G3 + #1627 merge/flight. Derek's "incomplete integration validation,"
  but it IS a real cross-process write→pod proof.
- **(B) All-on-prod** — prod operator + node deployed on prod. The true-production
  proof. Requires prod substrate that today exists **only** for candidate-a:
  OpenFGA store (`OPENFGA_STORE_ID`), `operator-secrets-writer` SA in the prod
  overlay, `production-node-secrets-writer` role, model bootstrap with
  `can_manage_secrets`.
- **(C) Target-env param (productization)** — if the intent is "owner on the prod
  operator sets a secret for the node's candidate-a/preview/prod deployment," the
  write must target the **node's** chosen env, not the operator's. A deliberate,
  authz-scoped `targetEnv` parameter — a design change to the env-stamping. This
  is likely the real product shape; it is NOT in #1627.

## Validation layers

| Layer                                       | Proves                                                                                                                                         | Status / prereq                                                                                                  |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| **L0** unit/component (CI)                  | authz logic, allowlist gate, adapter put-vs-patch, value-not-in-URL                                                                            | exists on #1627                                                                                                  |
| **L1** candidate-a authz integration        | four-state grant loop on the secrets route: `403 authz_denied` → grant `developer` → `403 key_not_allowed` (flip = RBAC pass) → revoke → `403` | **DONE** 2026-06-15 (gates 1–2). #1627 flighted; owner-approved via captured Playwright session on an owned node |
| **L2** candidate-a full write               | grant → write an **allowlisted** A2 key → KV version in API response → ESO→pod env shows it                                                    | needs **G2 + G3**; single-env candidate-a                                                                        |
| **L3** PROPER e2e (human-in-loop, deployed) | non-Derek-cred path: human owner approves in the **deployed UI**; agent writes throwaway secret; value reaches the node's running pod          | needs L2 + a chosen env target (A/B/C) + **human approval in UI** + throwaway node declaring an A2 key           |

## "Ready for proper e2e" checklist

- [ ] #1627 merged (or app+infra levers pinned to its SHA on the target env)
- [ ] **G1** UI honesty shipped (developer grant names manage-secrets)
- [ ] **G2** allowlist codegen + throwaway node declares ≥1 A2 key
- [ ] **G3** `<env>-node-secrets-writer` role provisioned via the routine infra lever (DRY) on the target env
- [ ] target env has OpenFGA store + model bootstrapped with `can_manage_secrets`
- [ ] **env-axis target chosen** (A all-candidate-a / B all-prod / C targetEnv param)
- [ ] human owner approves the grant in the deployed Agents UI

When every box is checked I will signal **ready for the human-in-the-loop e2e**.

## Env-axis decision (recommended: B, incrementally) — reject C

Top-0.1% reading of the env-axis constraint above: **per-env operator writes its own
env's path is a security FEATURE, not a limitation.** Each env's operator self-logins
with its own `<env>-node-secrets-writer` identity, scoped to `cogni/data/<env>/*`. So:

- **Recommend B (per-env), reached incrementally** — candidate-a first (= option A as
  step 1), then preview, then production, each its own gated rollout. Least-privilege,
  no cross-env operator, env isolation preserved.
- **Reject C (`targetEnv` param)** — one operator writing into other envs' paths
  **collapses the env-axis isolation** that the design treats as a security boundary.
  A prod operator that can write candidate-a/preview secrets is a strictly worse blast
  radius. Don't trade the boundary for one fewer grant.

## Beacon — first real node, unblock sequence

Beacon (`node_id f97f68f2-8406-4a3b-b5a9-d579b779f19d`, catalog envs
`[candidate-a, preview, production]`) is the proving node. Its overlays are already
**ESO-first** (`beacon-env-secrets`) on all three envs — no canary-style legacy trap.
Sequenced (option B):

| Phase | Unblocks | Work | Gate |
| ----- | -------- | ---- | ---- |
| **0 health** | all live proof | Caddy/edge regression in `reconcile-node-substrate.sh` (handed off) | flights green |
| **1 candidate-a** | beacon self-serves on candidate-a | **G3** role via routine infra lever + OpenFGA model bootstrap (`can_manage_secrets`) on candidate-a + grant beacon owner `secrets_manager` + verify beacon's candidate-a ExternalSecret leaf exists | **L2→L3**: 200 write → ESO → beacon pod → scorecard |
| **2 preview** | beacon preview env | reopen #1728 **preview** leg + preview OpenFGA model + role | Phase-1 proven |
| **3 production** | beacon prod env | **separate** high-privilege prod PR (authority-reviewed) + prod OpenFGA model + role | Phase-2 proven |

`node-template` needs **no per-node change** — self-serve is operator-side (one pod
serves every node) and #1721's denylist means no allowlist upkeep; forks inherit it
once the env substrate (G3 + model) is in place. **#1728 (preview+prod writer identity
in one sweep) was closed** — preview/prod each become their own gated PR per the table.

## L1 evidence (as run)

Four-state proof on owned node `rbac-probe-temp` (`8ad7a9b7`), requester a
separate registered agent, owner-approved via the captured operator session:

```
STATE 1 deny    POST /nodes/{id}/secrets → 403 {"errorCode":"authz_denied"}
GRANT           access-requests{developer} 201 → developers{approve} 200
STATE 3 flip    POST /nodes/{id}/secrets → 403 {"errorCode":"key_not_allowed"}   ← RBAC PASSED (moved to Gate 2)
STATE 4 revoke  developers{reject} 200 → 403 {"errorCode":"authz_denied"}
```

The flip `authz_denied → key_not_allowed` proves `developer → can_manage_secrets`
authorizes the write; Gate 2 then blocks an undeclared key. No value was written
(L2 not yet reached): Gate 2 (G2) and the OpenBao role (G3) are the remaining
work for a real write.
