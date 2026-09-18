---
name: node-catalog
description: >
  The node roster + operator-governance map for devs working in this repo. Use to answer "what nodes
  exist / are they live / what are their URLs", "who owns a node and what can the operator do to it",
  or "which parts are the node's vs the operator's". A where-to-look reference, NOT a doer — for
  actions use deploy-node / node-wizard-expert / promote / manage-node-envs. Triggers: "list the
  nodes", "node roster", "node URLs", "is <node> live", "operator's role/permissions over nodes".
---

# node-catalog — node roster + operator-governance map

## The roster is live state — read it, never hardcode

| Want                               | Source                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Who's registered + owner (per env) | `GET /api/v1/nodes` (owner Bearer) — the Postgres `nodes` SSOT. Per-env status: `GET /api/v1/nodes/{id}/deploy-state`.                          |
| Git-declared in-repo nodes         | `infra/catalog/*.yaml` `type:node` — read the rows, do not trust any list written here (`litellm`/`openfga`=infra, `scheduler-worker`=service). |
| Is it actually serving             | `curl https://<host>/version` from **outside** the cluster (buildSha, not workflow-green).                                                      |

**URL rule** (`verify-buildsha.sh`): operator = the bare env domain; every other node = `<node>-<envprefix>.<base>`.

- prod `cognidao.org` / `<node>.cognidao.org` · preview `preview.cognidao.org` / `<node>-preview…` · candidate-a `test.cognidao.org` / `<node>-test…`

**External submodule nodes** (e.g. blue, oss, habitat) carry their own repo-spec `node_id` — they show in `GET /api/v1/nodes` but **not** the in-repo catalog. Not-in-catalog + not-serving = an external node's own deploy, not an in-repo gap.

## Operator's role: node declares shape; operator wires environment

- **Node owns** (edit in the node repo): app code, packages, base manifests, image build, declarations (`repo-spec.yaml`, DB schema, `secrets-catalog.yaml`).
- **Operator owns** (the deploy plane): catalog, overlays/AppSets, provisioning, DNS, **flight + promotion**, secret **values**, env ownership.
- **Identity SSOT is one value:** repo-spec `node_id` = `nodes.id` = OpenFGA `node:<id>` = Loki `node` label. Address a node by that id (slug also resolves). The operator is itself a uniform node.

## What the operator can do to a node — and its limits (all OpenFGA-gated)

Every write is `(node_id, env)`-scoped, resolves the node via the registry, gates OpenFGA `node:<id>`, and runs as the operator's own identity — the caller holds only an API key.

| Action                           | Endpoint                                                   | Role                  |
| -------------------------------- | ---------------------------------------------------------- | --------------------- |
| Flight → candidate-a             | `POST /api/v1/vcs/flight`                                  | `developer`           |
| Merge a node PR (on green)       | `POST /api/v1/vcs/merge`                                   | `developer`           |
| Promote → production             | `POST /api/v1/deploy/promote`                              | `production_promoter` |
| Write/rotate a node secret value | `POST /api/v1/nodes/{id}/secrets`                          | `secrets_manager`     |
| Read deploy-state / logs         | `GET /api/v1/nodes/{id}/{deploy-state,observability/logs}` | `developer`           |

`owner` (the repo-spec governance-approver wallet) RLS-owns the row and approves access-requests (`POST /nodes/{id}/access-requests` → `POST /nodes/{id}/developers`). `403 authz_denied` = no grant; `503 authz_unavailable` = OpenFGA store unbootstrapped (not a denial).

**Limits:** the operator is the deploy plane only — code, work-items, and knowledge live elsewhere (node repo · work API · the Dolt hub). It does **not** edit a node's app code or run/freeze a node's **own** CI (external nodes keep their GitHub Actions), and it can't promote/secret a node absent from that env's registry (`node_not_found` → seed first).

## Canon (verify against these; don't restate)

- [`node-baas-architecture.md`](../../../docs/spec/node-baas-architecture.md) · [`cicd-platform-boundary.md`](../../../docs/spec/cicd-platform-boundary.md) (`OPERATOR_PLANE_CONTRACT`)
- Doers: [`/promote`](../promote/SKILL.md) · [`node-wizard-expert`](../node-wizard-expert/SKILL.md) · [`deploy-node`](../deploy-node/SKILL.md) · RBAC: [`rbac-expert`](../rbac-expert/SKILL.md)
- Also mirrored in the operator Dolt hub as `operator-node-catalog`.
