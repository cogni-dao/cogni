# litellm · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Custom LiteLLM Docker image extending upstream with per-node billing callback routing. The `CogniNodeRouter` routes unchanged billing events using the authenticated virtual-key alias `cogni:<lane>:<node UUID>:app:v1`. Only a verified master key may use local legacy node routes.

## Pointers

- [Multi-Node Tenancy Spec](../../../docs/spec/multi-node-tenancy.md): CALLBACK_IS_ADAPTER_GLUE, AUTHENTICATED_WORKLOAD_ROUTING
- [Billing Ingest Spec](../../../docs/spec/billing-ingest.md): Callback pipeline, ingest endpoint contract

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": [
    "app",
    "features",
    "ports",
    "core",
    "adapters",
    "shared",
    "services",
    "packages"
  ]
}
```

**External deps:** `litellm` (upstream image), `httpx` (async HTTP).

## Public Surface

- `cogni_callbacks.CogniNodeRouter` — CustomLogger subclass for LiteLLM success callbacks
- `Dockerfile` — extends `ghcr.io/berriai/litellm` with the custom callback module

## Env Vars

- `COGNI_NODE_ENDPOINTS` (required) — comma-separated authenticated workload alias or local legacy `node_id=base_url` pairs
- `LITELLM_MASTER_KEY` — existing gateway key; its hash verifies the local compatibility path
- `COGNI_DEFAULT_NODE_ID` — local primary node for master-key calls without node attribution
- `BILLING_INGEST_TOKEN` — Bearer token forwarded to node ingest endpoints

## Responsibilities

- This directory **does**: build a custom LiteLLM image, route billing callbacks to per-node ingest endpoints based on server-stamped key identity and exact catalog routes
- This directory **does not**: contain pricing logic, policy logic, reconciliation logic, or any business rules (CALLBACK_IS_ADAPTER_GLUE)

## Notes

- Virtual-key aliases must match an exact configured lane/node route; conflicting node claims fail closed.
- Missing `node_id` defaults to the primary node only with verified master-key authentication. Unknown identities never fall back.
- Catalog routing includes only declared lanes controlled by this gateway; foreign lanes have no legacy UUID/slug route.
- Dockerfile extends the same SHA-pinned upstream image used previously in docker-compose
- `COGNI_NODE_ENDPOINTS` is required — `CogniNodeRouter` raises `RuntimeError` at init if unset
