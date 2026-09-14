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
 * Empty-birth ordering, carried explicitly rather than left to the XRD default so the
 * committed desired state states its own precondition (bug.5116): a fresh node's schemas
 * must exist before its paid lease does. Legacy parity — the bespoke controller ran the
 * per-digest migration Job before any provider transaction unconditionally.
 */
const MIGRATION_POLICY = "RequireBeforeTransaction" as const;

/**
 * BOOT_SLO_OR_CLOSE, resolved from the one thing that already decides disposability: the
 * environment. `candidate-a` is the transient proof slot — a candidate that never serves its
 * exact SHA has no forensic value worth paying rent for, so its lease is closed. `preview`
 * and `production` hold, because a live environment that stops serving is an incident to
 * inspect, not a lease to silently reclaim.
 *
 * This is deliberately NOT a caller flag: a per-request "is this disposable?" input is exactly
 * the seam through which a production workload would eventually get closed by a bad argument.
 */
export function bootPolicyForEnvironment(
  environment: DeploymentEnvironment
): XComputeWorkloadBootPolicy {
  return { onDeadline: environment === "candidate-a" ? "Close" : "Hold" };
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
 * ABSENT IS SUPPORTED and is the current default here: the composite omits the substrate env
 * block (no Temporal / Redis / LiteLLM wiring) rather than guessing, exactly as the legacy
 * path degraded on an unparseable DSN. It is deliberately NOT derived from `--domain`: the
 * substrate address is the environment VM's host (`HOST_IP` in scripts/ci/deploy-infra.sh),
 * which is not the public apex. Deriving it would silently point a node at the wrong
 * substrate, which is strictly worse than omitting it.
 */
export interface XComputeWorkloadRuntime {
  readonly substrateHost: string;
}

/**
 * The Crossplane composite's spec. A field-for-field superset of the legacy CR spec: the three
 * additions are policies the bespoke controller held as compiled-in behaviour and a declarative
 * API has to state (see infra/crossplane/xcomputeworkload/xrd.yaml).
 */
export interface XComputeWorkloadSpec extends ComputeWorkloadSpec {
  readonly migration: { readonly policy: typeof MIGRATION_POLICY };
  readonly bootPolicy: XComputeWorkloadBootPolicy;
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
            ...(input.dns ? { dns: input.dns } : {}),
            ...(input.runtime ? { runtime: input.runtime } : {}),
          }
        : spec,
  };
}
