---
id: bug.0365
type: bug
title: "promote-and-deploy: no way to promote a single node — all-or-nothing at the overlay layer"
status: needs_triage
revision: 1
priority: 2
rank: 2
estimate: 2
created: 2026-04-23
updated: 2026-04-23
project: proj.cicd-services-gitops
assignees: []
summary: "promote-and-deploy.yml iterates every NODE_TARGET (operator, poly, resy) + scheduler-worker unconditionally. You cannot dispatch 'promote only poly'. Preview-forward mode (bug.0364) cascades all four preview digests to production in one shot. There is no per-node lever, no way to hold back a known-bad node, no way to roll operator independently of a poly hotfix. The preview → prod advance is a coupled bundle."
outcome: "promote-and-deploy accepts an optional `apps=<csv>` input; when set, resolves + promotes only those apps; untouched overlays remain at their existing digests. Default (unset) keeps current all-nodes behavior for flight-preview auto-dispatch. Same escape hatch exists for emergency-hotfix and preview-forward modes."
---

# Bug: no per-node promotion lever

## Symptoms

- "We merged a poly-only fix and want to ship it to prod" — requires promoting operator + resy + scheduler-worker too, whether they're ready or not.
- "Preview poly is broken but operator is fine" — can't advance just operator to prod; every prod dispatch drags poly along.
- "Hotfix operator on prod while leaving poly alone" — no path exists. Must either cherry-pick into preview first (which bundles poly) or abandon the per-node independence promise.

## Root cause

`.github/workflows/promote-and-deploy.yml` Update-overlay step iterates **every** target:

```bash
for node in "${NODE_TARGETS[@]}"; do
  app_digest=$(... "$node" ...)
  mig_digest=$(... "${node}-migrator" ...)
  promote_app "$node" "$app_digest" "$mig_digest"
done
sw_digest=$(... "scheduler-worker" ...)
promote_app scheduler-worker "$sw_digest" ""
```

No filter input. The only implicit scoping is affected-only CI skipping empty digests — which only works when a dispatch happens to correspond to a single-PR build. Manual dispatches (preview-forward, emergency hotfix) promote the whole bundle.

This couples the four nodes at the CI/CD layer, contradicting the hexagonal "sovereign node" architecture. Each node has its own overlay directory, its own namespace, its own ApplicationSet entry in Argo — but promotion doesn't honor that boundary.

## Fix (proposed)

1. Add optional `apps` input to `promote-and-deploy.yml` — CSV of app names (`operator`, `poly`, `resy`, `scheduler-worker`).
2. In the resolve + promote steps, intersect `apps` with the catalog before iterating. Empty/unset = current all-nodes behavior (preserves `flight-preview.yml` auto-dispatch contract).
3. `verify-buildsha` and `wait-for-argocd` already scope by `promoted_apps`, so they naturally restrict to the requested subset with no extra plumbing.
4. Escape hatch: `-f apps=poly` dispatches **only** poly (+ poly-migrator); other overlays on deploy/{env} are untouched.

## Validation

- exercise: `gh workflow run promote-and-deploy.yml -f environment=production -f apps=operator -f skip_infra=true` — expect `promoted_apps=operator`; poly + resy + scheduler-worker overlays unchanged on deploy/production; operator Deployment rolls in cogni-production; no poly migrator Job re-run.
- observability: Argo CD shows only `operator-*` apps transitioning to OutOfSync → Healthy in the post-dispatch window; `poly-*` / `resy-*` apps remain at their pre-dispatch revision.

## Not in scope

- Per-node ApplicationSet independence (already exists; each node is its own Argo Application).
- Preview lease semantics — preview-forward mode with `apps=` would still promote only the named subset; preview lease remains per-environment, not per-app (separate concern if we want it).
- Multi-app atomicity during rollback — if a bundle dispatch fails halfway, the successful overlays stay advanced. Same behavior today; surfaced as an observation but not changed by this fix.

## Related

- bug.0364 — preview-forward mode (the vehicle that exposed this coupling; dispatches 4 nodes at once)
- task.0324 — per-node migrator pairing (solved the migrator half of the independence story; this bug is the remaining half)
