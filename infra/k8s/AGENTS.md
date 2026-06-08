# k8s · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Kubernetes deployment manifests (k3s + Argo CD). Kustomize bases define app/service
contracts; overlays apply environment-specific configuration. Argo CD reconciles
manifests to the cluster. App discovery driven by `infra/catalog/*.yaml`.

## Pointers

- [CD Pipeline E2E](../../docs/spec/cd-pipeline-e2e.md): Full deployment specification
- [CI/CD & Services GitOps](../../work/projects/proj.cicd-services-gitops.md): Parent project
- [Services Architecture](../../docs/spec/services-architecture.md): Service contracts

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** Kustomize overlays consumed by Argo CD
- **CLI:** `kubectl kustomize infra/k8s/overlays/{staging,production}/{app}/`

## Responsibilities

- This directory **does**: Define K8s manifests for all apps and services (Deployments, Services, ConfigMaps, Secrets, migration Jobs)
- This directory **does not**: Contain application code, Dockerfiles, CI scripts, or renderer-agnostic catalog definitions

## Directory Structure

```
k8s/
├── argocd/                  # Argo CD configuration
│   ├── kustomization.yaml   # Non-HA Argo CD v2.13.4 install
│   ├── ksops-cmp.yaml       # SOPS CMP plugin for secret decryption
│   ├── repo-server-patch.yaml # ksops sidecar
│   └── <env>-<node>-applicationset.yaml # one AppSet per (env,node) → cogni-<env>-<node>
│                              # rendered by scripts/ci/render-node-appset.sh (LANE_ISOLATION)
├── base/                    # Kustomize bases
│   ├── node-app/            # Shared base for operator, poly, resy
│   ├── openfga-external/    # Operator opt-in bridge to Compose OpenFGA
│   ├── scheduler-worker/    # Temporal worker service
│   └── sandbox-openclaw/    # OpenClaw gateway service
├── overlays/                # Environment-specific patches
│   ├── staging/{app}/       # Per-app staging overlays (image digests, NodePorts)
│   └── production/{app}/    # Per-app production overlays
└── secrets/                 # SOPS/age encrypted K8s Secrets
    ├── .sops.yaml           # Encryption rules (age public keys per env)
    ├── staging/             # Per-app encrypted secrets
    └── production/          # Per-app encrypted secrets
```

## Standards

- **IMAGE_IMMUTABILITY**: Overlays use `@sha256:` digests, never mutable tags
- **MANIFEST_DRIVEN_DEPLOY**: Promotion = changing image digest in overlay
- **ROLLBACK_BY_REVERT**: Git revert restores previous digest
- **NO_SECRETS_IN_MANIFESTS**: All secrets SOPS-encrypted at rest
- **CATALOG_DRIVEN**: ApplicationSet reads `infra/catalog/*.yaml`, not hardcoded lists

## Change Protocol

- Adding a new app/node: add `infra/catalog/{name}.yaml`, create overlay, add SOPS secret
- Promoting an image: update overlay `images:` section with new digest
- Update this file when **directory structure changes**

## Notes

- Renamed from `infra/cd/` during CD pipeline restructure (see `docs/spec/cd-pipeline-e2e.md`)
- Node overlays use `namePrefix: {name}-` — configmap DNS values must match prefixed service names
- SOPS secrets use age encryption; private key injected at cluster bootstrap, not stored in repo
- Argo CD install is pinned to v2.13.4 (non-HA) — update version deliberately
- Update this file when **directory structure changes**
