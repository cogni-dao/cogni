---
name: cicd-secrets-expert
description: "Secrets architecture reference for node-template — when to use OpenBao+ESO vs GitHub env secrets, which operation pattern fits which write/rotate/add flow, the load-bearing invariants from the spec, the YAML catalog + Zod-loader the script consumes, and where to find the canonical implementation. Use when adding/rotating a secret, designing a service that consumes secrets, debugging an ExternalSecret or writer-role login, deciding between substrate and Compose-infra routing, touching `pnpm secrets:set` / `scripts/secrets/` / `scripts/lib/secrets-catalog-loader.ts` / `nodes/<node>/.cogni/secrets-catalog.yaml` / `infra/secrets-catalog.yaml` / `infra/k8s/argocd/{openbao,external-secrets}/` / per-node ExternalSecret manifests, or evaluating any new workflow that touches secret values. Triggers: 'add a secret', 'add a node secret', 'rotate a key', 'OpenBao', 'ESO', 'ExternalSecret', 'secrets-catalog', 'catalog tier', 'A1', 'A2', 'B-tier', 'writer role', 'bao login', 'vault-action', 'vault-config-operator', 'secrets-manage', 'secret in GH env vs OpenBao', 'where do I put this credential', 'per-node catalog'."
---

# Secrets guidance

The operator hub owns the maintained secrets contract and procedure.
Using the operator's saved COGNI_NODE_API_KEY, read the full content from:

1. GET https://cognidao.org/api/v1/knowledge/node-self-serve-secrets — adding a
   node credential or rotating a vendor value, including activation and recovery.
2. GET https://cognidao.org/api/v1/knowledge/secrets-management — required before
   changing custody, catalog/materialization, projection, authorization or rotation
   infrastructure. Read its linked dependencies for the affected boundary.

The index and this shell are routing instructions, not the contract. Read the
selected response bodies before acting; do not infer current behavior from an
older implementation snapshot.

| Additional boundary               | Read                                                                                                   |
| --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| External workload activation      | [Akash secret activation](https://cognidao.org/knowledge/akash-secret-needs-redeploy)                  |
| Catalog versus runtime projection | [Catalog ownership](https://cognidao.org/knowledge/secrets-catalog-is-ssot)                            |
| Vault/control environment         | [Lane custody](https://cognidao.org/knowledge/lane-is-not-control)                                     |
| Database credentials              | [Database contract](https://cognidao.org/knowledge/node-database-contract) and its owning dependencies |
| GitHub webhook counterpart        | [Webhook topology](https://cognidao.org/knowledge/gh-webhook-secret-topology)                          |
| Unmigrated classification details | [Classification](../../../docs/spec/secrets-classification.md)                                         |
| Bootstrap/outage custody          | [Provisioning skill](../provision-env/SKILL.md)                                                        |
| Substrate/chart rotation drill    | [Rotation guide](../../../docs/guides/secrets-rotate.md)                                               |

If hub retrieval fails, do not treat this pointer as permission to write or
rotate secrets. Preserve the failure and use the named bootstrap/recovery
instructions for an outage. Executable catalogs, schemas, scripts and tests
remain in Git; the hub contract links their implementation locations.
