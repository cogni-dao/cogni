---
name: deploy-operator
description: "Deploy/provision the Cogni operator (k3s + Argo CD). Node apps ship with POST /api/v1/deploy/workloads. Use for provisioning a VM/env, bringing a node live, promoting an image digest, debugging Argo sync / ImagePullBackOff / CreateContainerConfigError, or verifying deployment health. REDIRECT skill — the maintained detail lives in provision-env, devops-expert, cicd-secrets-expert."
---

# Deploy Operator — redirect

> This skill was a full playbook for the **old** deploy stack (canary/staging envs, `resy`
> node, SOPS secrets, `.env.operator`, `provision-test-vm.sh`, `deploy.sh`). **All of that
> is retired.** The content was purged 2026-08-05 to stop it misdirecting agents (e.g. it
> pointed "pods won't start → missing Secret" at SOPS, when the real cause is a missing ESO
> ExternalSecret leaf). Use the maintained skills below — one source per concern.

## Where the current knowledge lives

| You want to…                                                                                                  | Skill                     |
| ------------------------------------------------------------------------------------------------------------- | ------------------------- |
| Provision / reprovision an env (VM→k3s→OpenBao→Compose infra→edge→DNS→operator Argo apps), phase map, gotchas | **`provision-env`**       |
| CI/CD pipeline, the one node deploy verb, the freeze policy, VM SSH policy                                    | **`devops-expert`**       |
| Secrets: OpenBao vs GitHub-env, ESO, the `pnpm secrets:set` roll, split-brain                                 | **`cicd-secrets-expert`** |
| Promote a SHA to preview/production, or diagnose a stuck promote                                              | **`promote`**             |
| RBAC / node access grants (register → approve → OpenFGA)                                                      | **`rbac-expert`**         |
| Which DB a table belongs in, migrations, Doltgres                                                             | **`database-expert`**     |

## The one mental model to carry over

**Provision builds the house; promote fills the furniture; the operator DB is the address book.**

1. **Provision** (`provision-env.yml`) stands up the **substrate + infra** (VM, k3s, OpenBao/ESO,
   Compose infra incl. scheduler-worker/litellm/doltgres, Caddy, DNS, the operator's Argo apps) and seeds
   the operator deploy branch — often with **placeholder image digests**. A green provision can still serve
   502: `/version.buildSha` from outside is the only "really live" signal.
2. **Promote** (`/promote`, operator only) fills the deploy branch with a **real image digest** → Argo
   runs the actual app. A node does not use this path; it calls `POST /api/v1/deploy/workloads`. Placeholder digest = `ImagePullBackOff` that never self-heals → promote.
3. **A node is only operable the "standard" way once it's a row in the operator `nodes` table.**
   The table can be empty even when the node's Postgres DB, k8s overlay, and pod all exist — infra
   ≠ registration. Without the registry row, `resolveNodeRef` 404s, so self-serve secrets / RBAC /
   operator-managed deploy don't work on it (you're left hand-patching OpenBao or authoring ESO
   leaves by hand — the non-standard path). Register via node-formation first.

Failure-mode quick map (all detailed in the skills above):
`CreateContainerConfigError` → missing ESO ExternalSecret leaf (`provision-env` Gotcha 18), NOT SOPS.
`ImagePullBackOff` after a green provision → placeholder digest → `/promote`.
