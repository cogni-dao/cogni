# crossplane · AGENTS.md

> Scope: this directory only. Keep ≤150 lines. Do not restate root policies.

## Metadata

- **Owners:** @derekg1729
- **Status:** draft

## Purpose

Pinned Crossplane packages plus the provider-neutral workload API
(`xcomputeworkload/`) and Composition that replace Cogni-owned generic
reconciliation semantics.

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
- **CLI:** `kubectl kustomize infra/crossplane/install/packages/`, `kubectl kustomize infra/crossplane/xcomputeworkload/`

## Responsibilities

- This directory **does:** pin Crossplane packages and define declarative compute lifecycle resources.
- This directory **does not:** contain credentials, desired-state instances, custom controller loops, CI workflows, or deployment scripts.

## Standards

- **OSS_OWNS_GENERIC_RECONCILIATION:** watches, retries, backoff, finalizers, adoption, and drift correction belong to Crossplane.
- **PACKAGES_ARE_IMMUTABLE:** provider and function references include a semantic version and OCI digest.
- **DESIRED_STATE_IS_ENV_SCOPED:** workload instances are namespaced and never committed under `install/`.
- **AUTHORITY_MOVES_EXPLICITLY:** adding an XR or mutating managed resource requires the story.5020 handoff gate; package installation alone has no deployment authority.
- **NO_SECRET_VALUES:** credentials reach the wire only as provider-http `{{ name:namespace:key }}` placeholders resolved from the existing ESO/OpenBao substrate at request time.
- **WIRE_IS_THE_5095_CONTRACT:** the Composition lowers the full-fidelity XR onto `@contracts/compute.akash-tx.v1`, a zod strictObject. An extra key is a permanent 400, so the lowering is a port of `toProvisionSpec` + `legacyCogniAppEnv`, not a redesign.
- **KEY_IS_STABLE:** `cogniKey = xcw:<namespace>:<name>:<leaseEpoch>`. Nothing bumps `leaseEpoch` implicitly — a key that varied per reconcile would mint a second paid lease.
- **MIGRATION_BEFORE_TRANSACTION:** every create and update states its precondition as the actuator's `migration` discriminated union. `Skip` is the default accumulator, so a template bug fails toward the gate. Migration COMMANDS never travel — `profile` names a set the actuator owns, and a caller-supplied command would make the gate advisory.
- **REFUSAL_IS_OBSERVABLE:** the actuator's stable refusal `code` is surfaced on `status.failure.reason` (bug.5115: a wallet block that reached only provider logs was invisible for hours). Retryability comes from the HTTP status — 409 and 5xx are Progressing, other 4xx are Failed — never from a table of codes, which is why `reason` is a patterned string and not an enum. Surfacing is purely observational: it never stops the lease from being reconciled, unlike a `bootPolicy` spend decision.

## Change Protocol

- Keep `install/` dormant until its task has candidate proof.
- Update `tests/ci-invariants/crossplane-{dormant-substrate,xcomputeworkload}.spec.ts` explicitly when a reviewed task activates further managed-resource kinds.
- Render-test any template change before flighting it: `function-go-templating` is Go + sprig, so a wrong argument ORDER fails SILENTLY (`regexReplaceAll "re" "" $x` returns `""` and the DNS record simply never appears). Vitest cannot catch this; render the inline template against a realistic XR with Go before you trust it.
- Do not add a bespoke provider/controller here when a maintained Crossplane provider or function covers the lifecycle behavior.

## Notes

- task.5094 installs only the dormant candidate-a substrate. task.5096 adds `xcomputeworkload/`: the XRD, the Composition, a `ManagedResourceActivationPolicy` that starts a controller for exactly `requests.http.m.crossplane.io`, and a credential-free `ClusterProviderConfig`. Still ZERO desired state — the first XR comes from an environment overlay (task.5097).
- **Known gaps, task.5096 (do not rediscover):**
  - The actuator's RUNTIME (entrypoint bundle, image layer, ClusterIP `Service/akash-tx-actuator`, and the `akash-tx-actuator-auth` token Secret) is NOT here. It is an app-lane object in the operator image, and `infra/k8s/**` outside `argocd/control-plane/candidate-a/` is a different deploy lane — mixing the two makes `POST /deploy/infra-reconcile` 422. Until it ships, the Composition renders correctly and every OBSERVE fails connection-refused. No lease can be minted.
  - ~~`spec.migration.policy` is carried but not enforced~~ — CLOSED by bug.5140. The precondition is enforced at the actuator's paid-transaction seam, not by a composed Job: the installed package set cannot compose one (`provider-kubernetes` v0.18.0 still ships no namespaced `.m.crossplane.io` types). The Composition lowers `spec.migration` into the actuator's REQUIRED `migration` discriminated union on every create and update. `RequireBeforeTransaction` must carry `profile`+`bundleDigest`+`image`+`doltgres`; `Skip` must carry nothing else; migration COMMANDS never travel, because a caller-supplied command would make the gate advisory.
  - `spec.runtime.substrateHost` exists because the legacy controller derived Temporal/Redis/LiteLLM addresses from the hostname inside the `DATABASE_URL` SECRET, which an engine that never sees a secret cannot do. Absent, that env block is omitted exactly as the legacy unparseable-DSN branch omitted it.
- Activation record (task.5094, story.5016 R2.3): `deploy/candidate-a-control-plane` is the Argo-watched
  desired state for `infra/k8s/argocd/control-plane/candidate-a/`. Merging the Crossplane Applications to
  `main` does NOT install them — the deploy ref must be advanced to a reviewed tree that contains them, via
  `POST /api/v1/deploy/infra-reconcile {nodeId, env:"candidate-a", sourceSha}` from the production operator
  (task.5100's control-plane lane). This PR exists to carry that tree; installation is proven by Crossplane
  pods/packages healthy in `cogni-candidate-a` with zero XRs, zero credentials, and zero Akash writes.
