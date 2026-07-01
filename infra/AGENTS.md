# infra · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Everything about how the system runs. Split by responsibility, not by tool.

## Pointers

- [CD Pipeline E2E](../docs/spec/cd-pipeline-e2e.md): Full deployment specification
- [catalog/](catalog/): Renderer-agnostic app/node inventory
- [k8s/](k8s/): Kubernetes deployment manifests (Argo CD + Kustomize)
- [compose/](compose/): Docker Compose stacks (VM-shared infra runtime)
- [grafana/](grafana/): Grafana Cloud dashboards and alerting resources as code
- [images/](images/): Infra-owned Docker image build contexts
- [provision/](provision/): Substrate/bootstrap (OpenTofu, cloud-init)
- [akash/](akash/): Future Akash SDL renderer

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** Kustomize overlays (k8s/), Docker Compose stacks (compose/), Terraform modules (provision/)
- **CLI:** `kubectl kustomize infra/k8s/overlays/{env}/{app}/`, `tofu plan` in `infra/provision/cherry/base/`

## Responsibilities

- This directory **does**: Define deployment manifests, infrastructure config, image builds, app catalog
- This directory **does not**: Contain application code, business logic, or test suites

## Directory Responsibilities

| Directory    | Answers                                 | Changes when...                      |
| ------------ | --------------------------------------- | ------------------------------------ |
| `catalog/`   | What apps/nodes exist?                  | A new node is added                  |
| `k8s/`       | How do apps deploy to Kubernetes?       | Image digests or manifests change    |
| `grafana/`   | What Grafana dashboards/alerts exist?   | Observability UI or alerting changes |
| `compose/`   | What infra services run on the VM?      | Infrastructure config changes        |
| `images/`    | How are infra-owned images built?       | LiteLLM/proxy code changes           |
| `provision/` | How is the VM created and bootstrapped? | Cloud provider or bootstrap changes  |
| `akash/`     | How do apps deploy to Akash?            | (Future — SDL renderer)              |

## Standards

- `catalog/` is the SSoT for nodes (`CATALOG_IS_SSOT`, ci-cd.md axiom 16). Each `catalog/<name>.yaml` declares: `name`, `type` (node/service), `port`, `node_id` (uuid; node only), `dockerfile`, `image_tag_suffix`, `migrator_tag_suffix`, `path_prefix` (consumed by `scripts/ci/detect-affected.sh`), and `{candidate_a,preview,production}_branch`. Remote-source nodes may also declare `artifacts[]` when one source repo/SHA publishes multiple deployable images; `overlay_target` and `kustomize_image` describe which GitOps overlay/image entry owns each digest. Schema is `catalog/_schema.json` (validated on every PR by `check-jsonschema`). Do not add runtime container config, image digests, or non-GitOps wiring here.
- `k8s/` and `akash/` are peer renderers. Both read from `catalog/`.
- `compose/` is for infra services intentionally kept off-cluster.
- `images/` contains only Dockerfiles and build contexts, not runtime config.
- `provision/` owns VM lifecycle. Runtime manifests go in renderers.

## Change Protocol

- Update this file when **top-level directory structure changes**
- Adding a new renderer: create `infra/{renderer}/` as peer to `k8s/`

## Notes

- `infra/cd/` was renamed to `infra/k8s/` and `infra/tofu/` to `infra/provision/` in the CD pipeline implementation
- `infra/litellm/` moved to `infra/images/litellm/`, `infra/compose/sandbox-proxy/` to `infra/images/sandbox-proxy/`
- See `docs/spec/cd-pipeline-e2e.md` §0 for the rationale behind the directory layout
