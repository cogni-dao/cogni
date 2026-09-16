# scripts/ops · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** stable

## Purpose

One-shot operator scripts that mutate remote state (git refs, paid external resources) outside the regular CI/CD pipeline. Distinct from `scripts/ci/` (workflow-invoked) and `scripts/setup/` (provisioning). Intended for occasional human-driven runs.

## Pointers

- [`bootstrap-per-node-deploy-branches.sh`](bootstrap-per-node-deploy-branches.sh): create + fast-forward `deploy/<env>-<node>` branches from each whole-slot `deploy/<env>` tip (task.0372 / `BOOTSTRAP_FAST_FORWARDS_BEFORE_MERGE`).
- [`recover-orphaned-akash-lease.sh`](recover-orphaned-akash-lease.sh): close an Akash lease no live controller still owns, prove it closed against Console, then clear the legacy `compute.cogni.io/external-resource` finalizer (bug.5189 / `CLOSE_BEFORE_CLEAR`). Handles both orphan shapes — a stuck `ComputeWorkload` (`--workload`) and a lease whose tracking object is already gone (`--dseq`).

## Boundaries

```json
{
  "layer": "scripts",
  "may_import": [],
  "must_not_import": ["*"]
}
```

## Public Surface

- **Exports:** none (executable shell scripts only)
- **Env/Config keys:** `ENVS` (CSV, default `candidate-a,preview,production`); `DRY_RUN` (1 = print plan, no push/no close/no finalizer clear); `BOOTSTRAP_ALLOW_DIVERGENCE` (1 = proceed past diverged per-node branches); `KUBECONFIG` + `NAMESPACE` (default `cogni-candidate-a`, for `recover-orphaned-akash-lease.sh`)

## Responsibilities

- This directory **does**: idempotent ops scripts that read/write `origin/deploy/*` refs, or recover paid external resources the deploy plane orphaned.
- This directory **does not**: ship CI logic (lives in `scripts/ci/`), provision VMs (lives in `scripts/setup/`), or carry app build steps.

## Notes

- Run from a clean local clone with push access to `origin/deploy/*`.
- `recover-orphaned-akash-lease.sh` needs `KUBECONFIG` for the env's cluster, not git push access. It never reads a credential into this process: every Console/actuator call is executed inside the `akash-tx-actuator` pod against its own projected secrets. It refuses to clear a finalizer whose lease closure it cannot prove by re-reading Console — a wedged namespace is recoverable, an orphaned paid lease is not.
