// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/compute-workload-manifest`
 * Purpose: Render a verified node artifact bundle as provider-neutral GitOps desired state.
 * Scope: Pure bundle-to-workload mapping. No OCI, git, workflow, secret, or provider I/O.
 * Invariants:
 *   - BUNDLE_REF_IS_DIGEST: desired state records the immutable OCI manifest, never its tag.
 *   - SERVICE_ARTIFACT_REFS: services reference bundle artifacts logically; images have one authority.
 *   - PRIVATE_IS_NON_GLOBAL: the repo declaration controls exposure without provider vocabulary.
 *   - NO_SECRET_VALUES_IN_GIT: only non-secret topology/config is rendered here.
 *   - ONE_SEAM_TWO_CALLERS (task.5097/story.5025): this is the ONLY constructor of a node's
 *     compute desired state. Both the ordinary per-node deploy lane (candidate-flight /
 *     promote-and-deploy, via scripts/materialize-compute-workload.ts) and the formation
 *     wizard's Spawn path (whose minted repo-spec feeds the identical bundle resolution —
 *     proven in scaffolded-node-deployment.test.ts) reach the cluster through this function.
 *     A new deploy path that renders its own workload YAML is the drift this module prevents.
 *   - ONE_AUTHORITY_PER_WORKLOAD (task.5097): `computeApi` selects EXACTLY ONE kind. The legacy
 *     ComputeWorkload and the Crossplane XComputeWorkload never coexist for a (node, environment);
 *     see `computeWorkloadManifestFile` for the structural half of that fence.
 * Side-effects: none
 * Links: story.5016, story.5025, task.5056, task.5096, task.5097, compute-workload.types.ts,
 *   infra/crossplane/xcomputeworkload/{xrd,composition}.yaml
 * @internal
 */

import type { ResolvedNodeArtifactBundle } from "@cogni/repo-spec";

import type {
  ComputeWorkloadSpec,
  DeclaredProvisionServiceSpec,
} from "@/ports";

import type { NodeComputeApi } from "./node-compute-api";
import type { DeploymentEnvironment } from "./node-deployment-provider";
import { assertRuntimeProfileSecretRefs } from "./node-services-workload-spec";

const DIGEST_PINNED_OCI_REF =
  /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;

/**
 * Empty-birth schema policy, carried explicitly rather than left to the XRD default so the
 * committed desired state states it as a one-line git diff (bug.5116): a fresh node's schemas
 * are migrated as a RELEASE step on every reconcile tick, and a failure gates READINESS.
 *
 * It was `RequireBeforeTransaction` until task.5135, which severed the migration from the paid
 * Akash transaction. Writing the NEW value is what moves a workload off the deprecated
 * lowering, so every rematerialize (flight, promote) migrates one more node onto the decoupled
 * path — there is no separate cutover to run.
 */
/**
 * The namespace running the actuator that mints every real node's lease. Single value on
 * purpose: one Console account ⇒ one ledger ⇒ one active writer, so there is exactly one
 * place a paid transaction can originate (akash-actuator-wallet-cutover).
 */
const PRODUCTION_ACTUATOR_NAMESPACE = "cogni-production";

const MIGRATION_POLICY = "RequireBeforeServing" as const;

/**
 * BOOT_SLO_OR_CLOSE, resolved from the one thing that already decides disposability: the
 * environment. `onDeadline` fires in exactly ONE situation — `status.serving` never became
 * true within `bootDeadlineSeconds` OF THE XR'S CREATION. It is not a running-lane health
 * policy, so "a live environment that stops serving" is not a case it can reach.
 *
 * That is why every NON-PRODUCTION lane closes. A lane that never served once has no forensic
 * value to pay rent for — there is nothing to inspect, because nothing ran. The earlier rule
 * held `preview` open for that unreachable incident case, and it was harmless only while
 * preview meant k3s, which costs nothing. task.5132 made preview a PAID Akash lease on the
 * production sponsor account, and the repo has no close path to fall back on: `story.5039`'s
 * deactivate half is unbuilt and `bug.5189` is what an orphaned lease costs. A never-serving
 * preview lease would bill until a human noticed.
 *
 * `production` still holds. A production promote that fails to boot is a real incident, the
 * PREVIOUS lease is still serving it, and the dead one is the evidence.
 *
 * This is deliberately NOT a caller flag: a per-request "is this disposable?" input is exactly
 * the seam through which a production workload would eventually get closed by a bad argument.
 * It keys on the same `environment === "production"` question as `actuatorNamespace` below —
 * one predicate, so a new non-production lane cannot arrive holding only half the policy.
 */
export function bootPolicyForEnvironment(
  environment: DeploymentEnvironment
): XComputeWorkloadBootPolicy {
  return { onDeadline: environment === "production" ? "Hold" : "Close" };
}

/**
 * The ONE file each authority is rendered into. The deploy-branch writer rsyncs the
 * materializer's output dir over `infra/k8s/overlays/<env>/<node>/` with `--delete`, so the
 * kind NOT selected leaves git in the same commit that introduces the kind that was. That is
 * the structural half of ONE_AUTHORITY_PER_WORKLOAD: distinct filenames make "both kinds are
 * committed" impossible to reach by accident, and the kustomization below names exactly one.
 */
export function computeWorkloadManifestFile(
  computeApi: NodeComputeApi
): string {
  return computeApi === "crossplane"
    ? "xcomputeworkload.yaml"
    : "compute-workload.yaml";
}

/** Cloudflare DNS intent. A Cloudflare zone id is a public identifier, not a credential. */
export interface XComputeWorkloadDns {
  readonly provider: "cloudflare";
  readonly zoneId: string;
}

export interface XComputeWorkloadBootPolicy {
  readonly onDeadline: "Hold" | "Close";
}

/**
 * Value-free runtime topology for the `cogni-node-app-v1` profile. The legacy controller
 * derived this from the hostname inside the DATABASE_URL SECRET VALUE, which an engine that
 * never sees a secret structurally cannot do — so the XRD hoisted it into desired state.
 *
 * WHAT `substrateHost` MUST BE: the environment VM, the single host that answers the shared
 * substrate ports (`SUBSTRATE_PORTS="5432,5435,6379,4000,7233"` in
 * scripts/ci/render-compute-egress-allowlist.sh). The legacy value was that VM's literal IP,
 * because `scripts/ci/deploy-infra.sh` builds `DATABASE_URL` from `HOST_IP=$(hostname -I …)`
 * and `sharedSubstrateEnv()` read `new URL(DATABASE_URL).hostname` back out of the secret.
 *
 * WHERE THE NON-SECRET FORM COMES FROM: that VM already has a published, UNPROXIED DNS
 * alias — `vm_host_for_env()` in scripts/setup/lib/fork-identity.sh, e.g.
 * `cogni-candidate-a.vm.cognidao.org`. `scripts/setup/provision-env-vm.sh` creates it as an A
 * record pointing at the same `VM_IP`, deliberately `proxied=false` so non-HTTP ports reach the
 * origin, and rewrites every in-cluster `{postgres,temporal,litellm,redis,doltgres}-external`
 * Service to that ExternalName. So the alias and the DSN hostname are the same machine by
 * construction, and only the alias is non-secret. Callers derive it with that primitive; see
 * `.github/actions/materialize-compute-workload/action.yml`.
 *
 * It is deliberately NOT derived from `--domain`: that is the browser-facing, Cloudflare-PROXIED
 * public apex (`test.cognidao.org`), which terminates 80/443 at the edge and drops 7233/6379/4000
 * outright. Pointing a node there would fail silently at first Temporal call rather than loudly.
 *
 * ABSENT IS STILL SUPPORTED: the composite omits the substrate env block (no Temporal / Redis /
 * LiteLLM wiring) rather than guessing, exactly as the legacy path degraded on an unparseable DSN.
 */
export interface XComputeWorkloadRuntime {
  readonly substrateHost: string;
}

/** RFC-1123 hostname, the `format: hostname` the XRD declares for `spec.runtime.substrateHost`. */
const SUBSTRATE_HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The Crossplane composite's spec. A field-for-field superset of the legacy CR spec: the three
 * additions are policies the bespoke controller held as compiled-in behaviour and a declarative
 * API has to state (see infra/crossplane/xcomputeworkload/xrd.yaml).
 */
export interface XComputeWorkloadSpec extends ComputeWorkloadSpec {
  readonly migration: { readonly policy: typeof MIGRATION_POLICY };
  readonly bootPolicy: XComputeWorkloadBootPolicy;
  readonly leaseGeneration: number;
  readonly dns?: XComputeWorkloadDns;
  readonly runtime?: XComputeWorkloadRuntime;
}

export interface ComputeWorkloadManifest {
  readonly apiVersion: "compute.cogni.io/v1alpha1";
  readonly kind: "ComputeWorkload" | "XComputeWorkload";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly spec: ComputeWorkloadSpec | XComputeWorkloadSpec;
}

export interface BuildComputeWorkloadManifestInput {
  readonly slug: string;
  readonly environment: DeploymentEnvironment;
  readonly bundleRef: string;
  readonly bundle: ResolvedNodeArtifactBundle;
  /** Normal catalog-derived hostname, without scheme. */
  readonly publicHost: string;
  /** Which reconciliation authority owns this (node, environment). Catalog-resolved. */
  readonly computeApi: NodeComputeApi;
  /**
   * Explicit lease replacement counter, catalog-resolved (`resolveNodeLeaseGeneration`,
   * absent cell = 0). Required rather than defaulted here so a new caller cannot silently
   * fall back to a generation that differs from the catalog's — the generation IS the
   * idempotence key's only varying component, and a divergence mints a SECOND PAID LEASE.
   *
   * NAME (task.5122): this was `leaseEpoch`. `epoch` is the attribution/distribution domain's
   * word (contributor activity windows, claimants, payouts); a compute-lease replacement
   * counter is a GENERATION. The rename moved no VALUE, so no idempotence key moved.
   */
  readonly leaseGeneration: number;
  /**
   * DNS intent for the Crossplane authority only — the legacy controller resolves its own zone
   * from an in-cluster secret, so passing it there would be desired state nothing reads.
   * Absent is a supported state: the composite still publishes the CNAME target it WOULD write
   * (`status.dns.target`), so intent stays observable where the write path is unconfigured.
   */
  readonly dns?: XComputeWorkloadDns;
  /**
   * Substrate topology for the Crossplane authority only. See {@link XComputeWorkloadRuntime}
   * for why this is an explicit caller input with no fallback.
   */
  readonly runtime?: XComputeWorkloadRuntime;
}

/**
 * Build the namespaced desired-state object Argo owns and the selected authority reconciles.
 * Identity, bundle, and workload topology are IDENTICAL across both authorities by
 * construction — they are computed once, below, and never branched on `computeApi`.
 */
export function buildComputeWorkloadManifest(
  input: BuildComputeWorkloadManifestInput
): ComputeWorkloadManifest {
  if (!DIGEST_PINNED_OCI_REF.test(input.bundleRef)) {
    throw new Error(
      "[compute-workload-manifest] bundleRef must be a digest-pinned OCI reference"
    );
  }

  const services: DeclaredProvisionServiceSpec[] = input.bundle.services.map(
    ({ artifact, service }) => {
      assertRuntimeProfileSecretRefs({
        serviceName: service.name,
        ...(service.runtimeProfile
          ? { runtimeProfile: service.runtimeProfile }
          : {}),
        secretRefs: service.secretRefs,
      });
      return {
        name: service.name,
        artifact,
        ...(service.runtimeProfile
          ? { runtimeProfile: service.runtimeProfile }
          : {}),
        ...(service.secretRefs.length > 0
          ? { secretRefs: service.secretRefs }
          : {}),
        ...(service.command ? { command: service.command } : {}),
        ...(service.args ? { args: service.args } : {}),
        port: service.port,
        visibility: service.visibility,
        bindings: service.bindings,
        bindHost: service.bindHost,
        ...service.resources,
      };
    }
  );

  if (input.computeApi !== "crossplane" && (input.dns || input.runtime)) {
    throw new Error(
      "[compute-workload-manifest] dns and runtime are carried only by the crossplane authority; the legacy controller derives both itself (zone from an in-cluster secret, substrate host from the DATABASE_URL value)"
    );
  }

  // A nonzero replacement generation on the legacy authority would be desired state nothing
  // reads — its idempotence key embeds the k8s metadata.generation, not this counter — so an
  // operator who bumped it to replace a closed lease would see nothing happen. Refuse rather
  // than ignore.
  if (input.computeApi !== "crossplane" && input.leaseGeneration !== 0) {
    throw new Error(
      "[compute-workload-manifest] leaseGeneration is carried only by the crossplane authority; the legacy controller keys its lease per k8s metadata.generation and reads no replacement counter"
    );
  }

  if (input.runtime) {
    if (!SUBSTRATE_HOSTNAME.test(input.runtime.substrateHost)) {
      throw new Error(
        "[compute-workload-manifest] runtime.substrateHost must be a lowercase RFC-1123 hostname"
      );
    }
    // THE MIS-WIRE GUARD. The one wrong value that would still render, still sync, and still
    // pass every static check is the node's own browser-facing host — the Cloudflare-proxied
    // apex a caller reaches for by reflex because it is the other hostname in scope. It drops
    // 7233/6379/4000 at the edge, so the node would boot and then fail its first Temporal call.
    // Refuse it here, where desired state is built, rather than 20 minutes later on a paid lease.
    if (input.runtime.substrateHost === input.publicHost) {
      throw new Error(
        "[compute-workload-manifest] runtime.substrateHost must be the environment VM host, not the node's public host"
      );
    }
  }

  const namespace = `cogni-${input.environment}`;
  // ONE identity, ONE bundle, ONE topology — shared verbatim by both authorities so the
  // Crossplane cutover can never silently change what is deployed, only who reconciles it.
  const spec: ComputeWorkloadSpec = {
    nodeId: input.bundle.nodeId,
    environment: input.environment,
    bundle: {
      ref: input.bundleRef,
      source: input.bundle.source,
      artifacts: input.bundle.artifacts,
    },
    workload: { name: input.slug, publicHost: input.publicHost, services },
  };

  return {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind:
      input.computeApi === "crossplane"
        ? "XComputeWorkload"
        : "ComputeWorkload",
    metadata: {
      // Both the CRD and the Composition's first pipeline step make this immutable and equal
      // to spec.nodeId: one paid workload per node in each environment namespace.
      name: input.bundle.nodeId,
      namespace,
      labels: {
        "cogni.io/node-id": input.bundle.nodeId,
        "cogni.io/environment": input.environment,
        "cogni.io/node": input.slug,
      },
    },
    spec:
      input.computeApi === "crossplane"
        ? {
            ...spec,
            migration: { policy: MIGRATION_POLICY },
            bootPolicy: bootPolicyForEnvironment(input.environment),
            // Emitted even at 0, like migration.policy (bug.5116): the committed desired
            // state states its own idempotence-key generation rather than inheriting a
            // default, so a catalog bump is a visible one-line git diff on the deploy branch.
            //
            // CANONICAL NAME ONLY (task.5122). The deprecated `leaseEpoch` alias is NOT
            // dual-written: every environment's control plane already serves and prefers
            // `leaseGeneration` (the XRD/Composition bridge tracks `main` with selfHeal on
            // preview/production and deploy/candidate-a-control-plane on candidate-a), and
            // writing only the canonical field is what CONVERGES each deploy ref off the
            // alias. Dual-writing would pin `leaseEpoch` into every ref forever and make the
            // alias unremovable.
            leaseGeneration: input.leaseGeneration,
            // WHICH writer mints this lease (task.5132). A node app runs on AKASH, so its XR
            // is pure desired state and the production cluster reconciles every akash node's
            // non-production lane — the AppSet for it is rendered into appsets/production/.
            // The actuator lives in `cogni-production` THERE, so a non-prod lane must say so:
            // the Composition defaults the writer lookup to the XR's own namespace, which in
            // that cluster is `cogni-candidate-a`/`cogni-preview` and runs no actuator, so the
            // call would fail closed.
            //
            // Production omits it and keeps the default — identical rendering to before.
            //
            // The idempotence key is NOT affected: it still derives from the XR's own
            // namespace, which is what keeps a node's pre-prod lease from colliding with its
            // production one.
            ...(input.environment === "production"
              ? {}
              : { actuatorNamespace: PRODUCTION_ACTUATOR_NAMESPACE }),
            ...(input.dns ? { dns: input.dns } : {}),
            ...(input.runtime ? { runtime: input.runtime } : {}),
          }
        : spec,
  };
}
