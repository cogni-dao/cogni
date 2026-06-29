# deploy-policy · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Pure resource-fit and deployment-policy logic shared by operator routes and CI
entrypoints. No filesystem, network, Kubernetes, GitHub, or environment access.

## Pointers

- [Operator fleet safety design](../../docs/design/operator-fleet-safety.md)
- [CI/CD Platform Boundary](../../docs/spec/cicd-platform-boundary.md)

## Boundaries

```json
{
  "layer": "packages",
  "may_import": ["packages"],
  "must_not_import": ["app", "features", "ports", "adapters", "scripts"]
}
```

## Public Surface

- **Exports:** `evaluateResourceFit`, `extractKubernetesWorkloads`,
  `loadEnvBudgetsFromYaml`, Kubernetes quantity parsing helpers, and related
  report types.

## Responsibilities

- This directory **does**: normalize Kubernetes manifests into deterministic
  resource demand reports and evaluate them against git-owned env budgets.
- This directory **does not**: render Kustomize overlays, call Conftest, mutate
  deploy state, or query live clusters/providers.

## Usage

```bash
pnpm --filter @cogni/deploy-policy test
pnpm --filter @cogni/deploy-policy typecheck
```

## Notes

- Conftest/Rego is the CI deny engine; this package normalizes rendered
  Kubernetes manifests into deterministic policy input and markdown/JSON
  reports.
