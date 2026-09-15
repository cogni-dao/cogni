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
│   ├── argocd-cm-runtime-patch.yaml # Cogni's argocd-cm keys as a MERGE-PATCH body (never a manifest)
│   ├── appsets/<env>/       # generated one-AppSet-per-(env,node) desired state
│   └── control-plane/<env>/ # env-scoped app-of-apps continuously reconciled by Argo
├── base/                    # Kustomize bases
│   ├── akash-tx-actuator/   # Private ClusterIP Akash transaction actuator (Crossplane calls it)
│   ├── akash-tx-actuator-service-name/ # Post-namePrefix transformer pinning that Service's name
│   ├── node-app/            # Shared base for operator, poly, resy
│   ├── openfga-external/    # Operator opt-in bridge to Compose OpenFGA
│   └── scheduler-worker/    # Temporal worker service
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
- `akash-tx-actuator` has its OWN OpenBao bucket + ExternalSecret (`cogni/<env>/akash-tx-actuator` → `akash-tx-actuator-env-secrets`), NOT the operator's. The operator ExternalSecret extracts the whole operator bucket into the Secret the public app takes via `envFrom`, so an Akash wallet credential there is readable by the internet-facing process. Add actuator keys to the dedicated ExternalSecret, never to `overlays/<env>/operator/external-secret.yaml`
- ONE documented exception to that prefix: `akash-tx-actuator`. The Crossplane Composition derives its URL from the namespace alone and cannot know a prefix, so each operator overlay lists `base/akash-tx-actuator-service-name` under `transformers:` (which run AFTER namePrefix) to restore the bare name
- SOPS secrets use age encryption; private key injected at cluster bootstrap, not stored in repo
- Argo CD install is pinned to v2.13.4 (non-HA) — update version deliberately
- Update this file when **directory structure changes**
