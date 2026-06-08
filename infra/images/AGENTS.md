# images · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Infra-owned Docker image build contexts. These produce images used by Compose services
or deployed to GHCR for k8s consumption.

## Pointers

- [litellm/](litellm/): LiteLLM proxy with custom CogniNodeRouter billing callback
- [openfga/](openfga/): OpenFGA runtime image with `curl` for Compose healthchecks
- [sandbox-proxy/](sandbox-proxy/): nginx gateway config templates for OpenClaw LLM proxy

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** Docker images (litellm, openfga), nginx config templates (sandbox-proxy)
- **CLI:** `docker build -f infra/images/litellm/Dockerfile infra/images/litellm/`; `docker build -f infra/images/openfga/Dockerfile infra/images/openfga/`

## Responsibilities

- This directory **does**: Contain Dockerfiles and build contexts for infra-owned images
- This directory **does not**: Contain runtime config, application code, or Kubernetes manifests

## Change Protocol

- Adding a new infra image: create `images/{name}/` with Dockerfile

## Notes

- `litellm/` was moved from `infra/litellm/` during the CD pipeline restructure
- `openfga/` wraps the upstream OpenFGA image with `curl` for runtime health probes
- `sandbox-proxy/` was moved from `infra/compose/sandbox-proxy/`
- Docker Compose references these via `build.context: ../../images/litellm`
