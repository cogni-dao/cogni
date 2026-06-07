# configs · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Service configuration files for runtime stack services (LiteLLM proxy, Grafana Alloy). Defines model routing with metadata, log collection pipelines, and datasource provisioning.

## Pointers

- [Parent: runtime](../AGENTS.md)
- [LiteLLM Provider Docs](https://docs.litellm.ai/docs/providers/openrouter)
- [Model Selection](../../../../docs/spec/model-selection.md)

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none
- **Env/Config keys:** `LITELLM_MASTER_KEY`, `OPENROUTER_API_KEY`, `LITELLM_DATABASE_URL`, `COGNI_NODE_ENDPOINTS` (per-node billing callback routing), `BILLING_INGEST_TOKEN` (billing callback auth), `GRAFANA_CLOUD_LOKI_URL`, `GRAFANA_CLOUD_LOKI_USER`, `GRAFANA_CLOUD_LOKI_API_KEY`, `METRICS_TOKEN`, `PROMETHEUS_REMOTE_WRITE_URL`, `PROMETHEUS_USERNAME`, `PROMETHEUS_PASSWORD`
- **Files considered API:** litellm.config.yaml, alloy-config.alloy, alloy-config.metrics.alloy, grafana-provisioning/datasources/loki.yaml, grafana-provisioning/datasources/postgres.yaml

## Responsibilities

- This directory **does**: configure LiteLLM model aliases with metadata, define Alloy log scraping and forwarding, provision Grafana Loki datasources
- This directory **does not**: contain executable code or deployment automation

## Usage

Mounted as volumes in docker-compose.yml.

## Standards

**LiteLLM Config** (`litellm.config.yaml`):

- Each `model_list` entry requires `model_name` (unique alias)
- `model_info` metadata required for UI: `display_name`, `is_free`, `provider_key`
- Provider routing via `litellm_params.model` (OpenRouter format)
- Env substitution: `os.environ/VAR_NAME`

**Alloy Config** (env-specific):

- `alloy-config.alloy` - Logs only (local dev); scrapes Docker containers → Loki; includes log noise suppression stages
- `alloy-config.metrics.alloy` - Logs + metrics (preview/prod); adds app, scheduler-worker, OpenFGA, cAdvisor, node exporter + prometheus.scrape → Mimir; strict metric allowlists + label cardinality policy
- docker-compose.dev.yml mounts `alloy-config.alloy`; docker-compose.yml mounts `alloy-config.metrics.alloy`
- Both configs share identical log noise suppression: drops successful fast health-check/metrics-scrape logs (fail-safe — only drops when JSON parses AND required fields match)
- Infra metrics: `prometheus.exporter.cadvisor` (container memory/CPU/OOM/network/disk) + `prometheus.exporter.unix` (host memory/CPU/filesystem/network); requires host mounts `/proc:/host/proc:ro`, `/sys:/host/sys:ro`, `/:/host/root:ro`
- Treating "metrics config without creds" as deployment misconfig (not tolerated)

## Dependencies

- **Internal:** none
- **External:** LiteLLM proxy service, Grafana Alloy, Grafana Cloud

## Change Protocol

- Update this file when config structure changes
- Bump **Last reviewed** date
- Update app model cache if LiteLLM API contract changes

## Notes

- litellm.config.yaml is single source of truth for model metadata and callback config
- Billing callback: custom `CogniNodeRouter` callback class (`infra/images/litellm/cogni_callbacks.py`) routes each completion to the correct node's `/api/internal/billing/ingest` endpoint based on `node_id` in metadata. Configured via `COGNI_NODE_ENDPOINTS` env var. Auth via `BILLING_INGEST_TOKEN` (Bearer token).
- App fetches from `/model/info` endpoint to read `model_info` fields
- Adding models: update config + restart LiteLLM, app cache refreshes within 1h
