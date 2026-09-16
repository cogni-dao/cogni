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
- **KEY_IS_STABLE:** `cogniKey = xcw:<namespace>:<name>:<leaseGeneration>`. Nothing bumps `leaseGeneration` implicitly — a key that varied per reconcile would mint a second paid lease.
- **IDENTITY_IS_STATED_NEVER_DERIVED:** every create and update carries `identity{nodeId, compositeUid, compositeGeneration}` so a paid lease is attributable to a NODE, not just to a wallet (task.5103). `nodeId` comes from the spec the identity gate already proved equal to `metadata.name`. NOTHING is defaulted — a fabricated `compositeGeneration` would record a revision that was never observed and the receipt's CHECK would accept it, so an absent generation or uid FAILS THE RENDER. Never let generation reach the `cogniKey`: the receipt records which revision asked, the key must not vary at all.
- **MIGRATION_IS_NOT_A_PAYMENT_PRECONDITION (task.5135):** the per-digest DB migration rides on OBSERVE — the UNPAID tick — as `migrationStep`, together with the `workload` + `environment` that say whose database it is. It NEVER travels on create/update, and no migration state can refuse a lease. A `failed` phase becomes `status.failure.reason: MigrationFailed` and outranks a RETRYABLE refusal (a stall that will never clear must not hide behind "Progressing"); it does not outrank a terminal refusal or the boot deadline. `spec.migration.policy: RequireBeforeTransaction` is a DEPRECATED alias kept only so XRs already on deploy refs keep the pre-task.5135 wire until their next rematerialize. Migration COMMANDS never travel — `profile` names a set the actuator owns; a caller-supplied command would run an arbitrary container against the environment's database under the actuator's service account.
  - _Why this changed:_ node toks5 held a valid XR in `cogni-production` with a valid image digest, its migration never ran, so the actuator was NEVER CALLED — `akash-lease` reported "not yet ready" 1044 times and the node existed in no environment at all. Silent, unbounded, no alarm.
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
  - `spec.migration.policy` is lowered onto the actuator's UNPAID observe, not onto a paid mutation and not onto a composed Job (task.5135, superseding bug.5140). The installed package set still cannot compose a Job — `provider-kubernetes` v0.18.0 ships no namespaced `.m.crossplane.io` types — so the runner remains co-hosted in the actuator process, reached through a seam that spends nothing. `RequireBeforeServing` lowers to a `migrationStep{profile,bundleDigest,image,doltgres}` on OBSERVE; presence is the whole policy, so there is no `Skip` member on that wire. **Open:** once a namespaced provider-kubernetes type exists, the step becomes its own composed resource and the runner leaves the wallet-holding process entirely.
  - `spec.runtime.substrateHost` exists because the legacy controller derived Temporal/Redis/LiteLLM addresses from the hostname inside the `DATABASE_URL` SECRET, which an engine that never sees a secret cannot do. Absent, that env block is omitted exactly as the legacy unparseable-DSN branch omitted it.
- Activation record (task.5094, story.5016 R2.3): `deploy/candidate-a-control-plane` is the Argo-watched
  desired state for `infra/k8s/argocd/control-plane/candidate-a/`. Merging the Crossplane Applications to
  `main` does NOT install them — the deploy ref must be advanced to a reviewed tree that contains them, via
  `POST /api/v1/deploy/infra-reconcile {nodeId, env:"candidate-a", sourceSha}` from the production operator
  (task.5100's control-plane lane). This PR exists to carry that tree; installation is proven by Crossplane
  pods/packages healthy in `cogni-candidate-a` with zero XRs, zero credentials, and zero Akash writes.
