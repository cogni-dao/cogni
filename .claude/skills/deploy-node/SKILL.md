---
name: deploy-node
description: "Router for 'deploy a node', 'ship my node app', 'deploy to candidate-a, preview or production', 'which nodes exist', 'check deployment status'. A node ships with one call: POST /api/v1/deploy/workloads. Routes each deploy question to the hub guide or skill that owns it."
---

# Deploy a node

A node ships with one call. Only `env` changes between environments.

```text
POST https://cognidao.org/api/v1/deploy/workloads   {nodeId, env, workload, sourceSha}
GET  https://cognidao.org/api/v1/deploy/workloads?nodeId=<id>&env=<env>
```

| `env`         | `sourceSha`                                |
| ------------- | ------------------------------------------ |
| `candidate-a` | The PR head, after review and green CI     |
| `preview`     | The merge commit. Automatic on merge.      |
| `production`  | The validated merge commit. Explicit call. |

Declare the app in `.cogni/workloads/<name>.yaml` in the node repo. CI publishes `sha-<sha>`. The operator does the rest.

Read these hub guides before the first call:

- [cicd-e2e-required-sequence](https://cognidao.org/knowledge/cicd-e2e-required-sequence) owns the order of steps and the gates.
- [deploy-a-declared-workload](https://cognidao.org/knowledge/deploy-a-declared-workload) owns the declaration, the call, the watch and the failure signatures.
- [node-service-delivery](https://cognidao.org/knowledge/node-service-delivery) owns the design.

## Do not hardcode the roster

The roster is live state. Read it:

| Want                        | Source                                                 |
| --------------------------- | ------------------------------------------------------ |
| Registered nodes and owners | `GET /api/v1/nodes`                                    |
| Per-env deploy state        | `GET /api/v1/nodes/{id}/deploy-state`                  |
| In-repo shape               | `infra/catalog/*.yaml`                                 |
| Did my deploy work, and why not? | `GET /api/v1/deploy/workloads/releases/<releaseId>?nodeId=&env=` |
| What is serving             | `curl https://<host>/version` from outside the cluster |

## Other owners

| Question                              | Owner                 |
| ------------------------------------- | --------------------- |
| Akash runtime, placement, leases      | `akash-node-expert`   |
| CI/CD design, freeze policy           | `devops-expert`       |
| Promote or flight the operator itself | `promote`             |
| Prove a flighted PR                   | `validate-candidate`  |
| Secrets                               | `cicd-secrets-expert` |
| Node access roles                     | `rbac-expert`         |
| Turn an env on or off for a node      | `manage-node-envs`    |
| Provision an env (operator only)      | `provision-env`       |

## Invariants

- Follow the release (`GET /api/v1/deploy/workloads/releases/<releaseId>`) to `active`; never poll `/version` to follow a deploy. After `active`, one `/version.buildSha` read from outside the cluster confirms the exact commit. A 200 from the verb, a green workflow or a lease is not proof.
- Missing placement is a hard failure. Never fall back to k3s.
- Never roll a node back to k3s. Fix forward.
- The operator is the exception. It stays on k3s and Argo (operator only): `POST /api/v1/vcs/flight`, then `POST /api/v1/deploy/promote`.
