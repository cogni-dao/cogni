---
name: manage-node-envs
description: "Manage which deploy environments (candidate-a / preview / production) a Cogni node lives in, via the operator app: request the env_manager role, owner approves, call the env verb, merge the catalog PR, verify. Use when asked to 'give this node a preview deploy', 'take a node out of preview', 'change a node's env set', or on a 403 authz_denied / 503 authz_unavailable from POST /api/v1/nodes/{id}/envs. Triggers on 'env_manager', 'can_manage_envs', 'env-membership PR', 'catalog envs: line'. Distinct from shipping a build (POST /api/v1/deploy/workloads), provisioning an env (provision-env) and secrets (cicd-secrets-expert)."
---

# Manage node env membership

Env membership answers which environments a node is deployed into. It is the `envs:` list and the `compute_api.<env>` cell in the node's catalog row `infra/catalog/<slug>.yaml`. It does not choose the build. The build ships with one call:

```text
POST https://cognidao.org/api/v1/deploy/workloads   {nodeId, env, workload, sourceSha}
```

Read [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence), [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload) and [env-verb-activation](https://cognidao.org/knowledge/env-verb-activation) (a catalog mutation is not proof that a lane serves).

## The loop

1. **Request the role.** `POST /api/v1/nodes/{id}/access-requests {"role":"env_manager"}`. This writes a tracking row only. It grants nothing.
2. **Wait for the owner.** The node owner approves with `POST /api/v1/nodes/{id}/developers {agentUserId, decision:"approve", role:"env_manager"}`. There is no other path. Never write authorization tuples. Never self-approve. Stop and wait.
3. **Call the verb.** `POST /api/v1/nodes/{id}/envs {"env":"candidate-a"|"preview"|"production","present":true|false}`. It opens a catalog PR on the operator monorepo. A request for the state that already holds returns `result.status:"no_changes"` and opens no PR. Use that as a grant probe.
4. **Merge when green.** `POST /api/v1/vcs/merge {nodeId, prNumber}`. It returns `422 not_green` until required checks pass. On green it enqueues. Poll the PR until `MERGED`.
5. **Ship and verify.** Call `POST /api/v1/deploy/workloads` for the env. Read `GET /api/v1/deploy/workloads?nodeId=<id>&env=<env>`. The proof is the served `/version.buildSha`. A merged PR is not a deployed node.

## Errors

| Code                          | Meaning                                                                                         |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `403 authz_denied`            | You lack `env_manager`. Go to step 1.                                                           |
| `503 authz_unavailable`       | The env's OpenFGA model lacks `can_manage_envs`. The env needs a model bootstrap. Do not retry. |
| `422 not_green`               | Required checks are pending or failed. Wait.                                                    |
| `422 operator_node_immutable` | The operator cannot be removed from an env.                                                     |

## Invariants

- **REQUEST_THEN_OWNER_APPROVE_ONLY.** `env_manager` comes only from request then owner approval.
- **DISTINCT_SCOPE.** `env_manager` gives `can_manage_envs`. It is separate from `developer` (`can_flight`) and `production_promoter` (`can_promote_production`). `admin` implies all three.
- **CATALOG_IS_SSOT.** The verb edits the operator monorepo catalog. It never touches the node's own repo.
- **ATOMIC_PER_ENV.** Each env is an independent toggle. candidate-a has no special case. Removing the last env leaves a valid `envs: []`.
- **IDEMPOTENT.** The state that already holds returns `no_changes`.
- **OPERATOR_SELF_HOSTS_THE_VERB (operator only).** The operator stays on k3s and Argo and cannot undeploy itself.
- The Deploy button on the node page can show for a viewer who lacks the grant. The verb is the real gate.
