# crossplane · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Pinned Crossplane packages and, in later R2 tasks, the provider-neutral workload
API and Composition that replace Cogni-owned generic reconciliation semantics.

## Pointers

- [CI/CD Platform Boundary](../../docs/spec/cicd-platform-boundary.md)
- [CI/CD Axioms](../../docs/spec/ci-cd.md)
- [Candidate Argo control plane](../k8s/argocd/control-plane/candidate-a/)

## Boundaries

```json
{
  "layer": "infra",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** Kustomize-renderable package, XRD, and Composition manifests
- **CLI:** `kubectl kustomize infra/crossplane/install/packages/`

## Responsibilities

- This directory **does:** pin Crossplane packages and define declarative compute lifecycle resources.
- This directory **does not:** contain credentials, desired-state instances, custom controller loops, CI workflows, or deployment scripts.

## Standards

- **OSS_OWNS_GENERIC_RECONCILIATION:** watches, retries, backoff, finalizers, adoption, and drift correction belong to Crossplane.
- **PACKAGES_ARE_IMMUTABLE:** provider and function references include a semantic version and OCI digest.
- **DESIRED_STATE_IS_ENV_SCOPED:** workload instances are namespaced and never committed under `install/`.
- **AUTHORITY_MOVES_EXPLICITLY:** adding an XR or mutating managed resource requires the story.5020 handoff gate; package installation alone has no deployment authority.
- **NO_SECRET_VALUES:** credentials are referenced through the existing ESO/OpenBao substrate only when a later task needs them.

## Change Protocol

- Keep `install/` dormant until its task has candidate proof.
- Update `tests/ci-invariants/crossplane-dormant-substrate.spec.ts` explicitly when a later reviewed task activates managed-resource kinds.
- Do not add a bespoke provider/controller here when a maintained Crossplane provider or function covers the lifecycle behavior.

## Notes

- task.5094 installs only the dormant candidate-a substrate; later story.5020 tasks own APIs, composition, authority handoff, and legacy deletion.
- Activation record (task.5094, story.5016 R2.3): `deploy/candidate-a-control-plane` is the Argo-watched
  desired state for `infra/k8s/argocd/control-plane/candidate-a/`. Merging the Crossplane Applications to
  `main` does NOT install them — the deploy ref must be advanced to a reviewed tree that contains them, via
  `POST /api/v1/deploy/infra-reconcile {nodeId, env:"candidate-a", sourceSha}` from the production operator
  (task.5100's control-plane lane). This PR exists to carry that tree; installation is proven by Crossplane
  pods/packages healthy in `cogni-candidate-a` with zero XRs, zero credentials, and zero Akash writes.
