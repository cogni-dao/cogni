# ci-invariants · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

Static structural tests that pin CI/CD-side policy invariants (workflow shape, action SHA-pins, fixture-asserted classifier behavior, GitOps manifest ownership) so policy drift between docs, workflow/manifest YAML, and runtime resolvers fails the local + CI gate.

## Pointers

- [.github/workflows/ci.yaml](../../.github/workflows/ci.yaml) — the workflows these tests pin
- [docs/spec/node-ci-cd-contract.md](../../docs/spec/node-ci-cd-contract.md) — the invariants
- [work/items/task.0381.\*](../../work/items/) — single-node-scope rationale
- [infra/k8s/argocd/argocd-cm-runtime-patch.yaml](../../infra/k8s/argocd/argocd-cm-runtime-patch.yaml) — the merge-patch body `argocd-core-configmap-ownership.spec.ts` pins

## Boundaries

```json
{
  "layer": "tests",
  "may_import": ["*"],
  "must_not_import": []
}
```

## Public Surface

- **Exports:** `classify(paths, nonOperatorNodes) → ClassifyResult` from `classify.ts` — reference TS implementation of the single-node-scope policy. Imported by parity tests; task.0382's runtime resolver must produce identical results on the same fixtures.
- **Fixtures:** `fixtures/single-node-scope/*.json` — shared diff fixtures (the contract surface task.0382 must match).
- **Routes (if any):** none
- **Env/Config keys:** none

## Responsibilities

- This directory **does**: pin runtime workflow filter generation from `nodes/*`, assert action SHA-pinning, replay shared fixtures through a reference classifier, forbid GitOps ownership of Argo's own `argocd-*` config (bug.5095).
- `lifecycle-commands.spec.ts` keeps `.claude/commands/*.md` and `.claude/skills/*/SKILL.md` from instructing a `staging` base, a local `pnpm check`/`check:fast` step, or `gh pr merge` (task.5293).
- This directory **does not**: invoke GitHub Actions or run network I/O. Git is prohibited except `maintenance-drain.spec.ts`'s finite local ancestry/CAS fixture. It uses only temporary repositories and local file remotes, disables global/system config, hooks and signing, bounds every command, and removes its directory on exit; it cannot operate on the checkout or authenticated remotes.

## Notes

- Adding or removing a node directory under `nodes/` needs no workflow edit; `render-scope-filters.sh` supplies that checkout's roster at runtime.
- When task.0382 lands, replace the `it.todo` cases in `single-node-scope-parity.spec.ts` with real assertions using the runtime resolver against the same fixtures.
