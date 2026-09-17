---
name: deploy-node
description: "Redirect. The k3s+ArgoCD node-app deploy playbook is RETIRED — node apps deploy to Akash via catalog placement. Routes deploy/provision/promote/health questions to the maintained skill that owns each, and to the Dolt roster for which nodes exist. Triggers: 'deploy a node', 'deploy to staging', 'provision a VM', 'check deployment status', 'promote image', 'Argo CD sync', 'which nodes exist'."
---

# Deploy Node — redirect

> This skill was a 344-line playbook for the **old k3s node-app stack** (`provision-test-vm.sh`,
> `staging-*` Argo apps, hardcoded VM IPs, `resy-test.cognidao.org`). **All of that is retired.**
> `deploy-operator` was purged for exactly this on 2026-08-05; this one survived and kept
> misdirecting agents. Purged now for the same reason.
>
> **`resy` never existed as a fleet node.** Any instruction naming it was hallucinated roster.

## The two facts that make the old content wrong

1. **Node apps deploy to Akash**, selected per environment by the catalog's `deployment_provider`
   (ci-cd.md Axiom 23 `AKASH_IS_NODE_APP_TARGET`). The k3s app lane is **deprecated for nodes** —
   never advise extending it, never "roll a node back to k3s" (that is a standing red line;
   `place_k3s` is not a mitigation, fix forward).
2. **k3s is still the STATE SUBSTRATE** and is NOT going away — postgres, doltgres, redis,
   temporal, LiteLLM, the shared scheduler-worker (Axiom 24 `CHERRY_IS_STATE_SUBSTRATE`).
   k3s knowledge is live and load-bearing for substrate work; it is only wrong as the _node-app_
   target.

## NEVER hardcode the roster — Dolt is the truth

Recall `operator-node-catalog`: **"The roster is LIVE STATE — read it, never hardcode."**

| want                                        | source                                                 |
| ------------------------------------------- | ------------------------------------------------------ |
| live registry (registered + owner, per env) | `GET /api/v1/nodes` — Postgres `nodes` SSOT            |
| per-env deploy state                        | `GET /api/v1/nodes/{id}/deploy-state`                  |
| git-declared in-repo shape                  | `infra/catalog/*.yaml` `type:node` (`CATALOG_IS_SSOT`) |
| **actually serving**                        | `curl https://<host>/version` from OUTSIDE the cluster |

**URL rule** (`verify-buildsha.sh`): operator = the bare env domain; every other node =
`<node>-<envprefix>.<base>`. prod `cognidao.org` / `<node>.cognidao.org`; preview
`preview.cognidao.org` / `<node>-preview…`; candidate-a `test.cognidao.org` / `<node>-test…`.

A hardcoded node list or host in any skill, workflow or script is drift waiting to happen —
that is how `resy` outlived the node by months.

## Where the current knowledge lives

| You want to…                                                                   | Skill                     |
| ------------------------------------------------------------------------------ | ------------------------- |
| Akash runtime, placement, leases, ComputeWorkload, why a node won't come up    | **`akash-node-expert`**   |
| CI/CD pipeline, deploy branches, image promotion, freeze policy, VM SSH policy | **`devops-expert`**       |
| Provision / reprovision an env (VM→k3s→OpenBao→Compose→edge→DNS→AppSets)       | **`provision-env`**       |
| Promote a SHA to preview/production, or diagnose a stuck promote               | **`promote`**             |
| Prove a flighted PR on candidate-a                                             | **`validate-candidate`**  |
| Secrets: OpenBao vs GitHub-env, ESO, split-brain                               | **`cicd-secrets-expert`** |
| RBAC / node access grants                                                      | **`rbac-expert`**         |
| Turn an env on/off for a node                                                  | **`manage-node-envs`**    |

## The invariant worth carrying over

**`/version.buildSha` read from outside the cluster is the only proof a deploy landed.**
A green workflow, a Healthy Argo app, and a 200 from `/readyz` can all be true while users are
served the previous build. Absence of a failure signal is not proof of health
(Dolt: `unexecuted-lane-untested`).

**And absent placement is a HARD FAILURE, never a k3s fallback** (`NO_SILENT_DEFAULT`,
story.5040) — a node row missing `deployment_provider` / `compute_api` / `lease_generation` for
an env it declares must halt with the missing cell named.
