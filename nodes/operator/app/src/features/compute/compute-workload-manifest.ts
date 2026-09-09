// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/compute-workload-manifest`
 * Purpose: Render a verified node artifact bundle as provider-neutral GitOps desired state.
 * Scope: Pure bundle-to-ComputeWorkload mapping. No OCI, git, workflow, secret, or provider I/O.
 * Invariants:
 *   - BUNDLE_REF_IS_DIGEST: desired state records the immutable OCI manifest, never its tag.
 *   - SERVICE_ARTIFACT_REFS: services reference bundle artifacts logically; images have one authority.
 *   - PRIVATE_IS_NON_GLOBAL: the repo declaration controls exposure without provider vocabulary.
 *   - NO_SECRET_VALUES_IN_GIT: only non-secret topology/config is rendered here.
 * Side-effects: none
 * Links: story.5016, task.5056, compute-workload.types.ts
 * @internal
 */

import type { ResolvedNodeArtifactBundle } from "@cogni/repo-spec";

import type {
  ComputeWorkloadSpec,
  DeclaredProvisionServiceSpec,
} from "@/ports";

import type { DeploymentEnvironment } from "./node-deployment-provider";
import { assertRuntimeProfileSecretRefs } from "./node-services-workload-spec";

const DIGEST_PINNED_OCI_REF =
  /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/;

export interface ComputeWorkloadManifest {
  readonly apiVersion: "compute.cogni.io/v1alpha1";
  readonly kind: "ComputeWorkload";
  readonly metadata: {
    readonly name: string;
    readonly namespace: string;
    readonly labels: Readonly<Record<string, string>>;
  };
  readonly spec: ComputeWorkloadSpec;
}

export interface BuildComputeWorkloadManifestInput {
  readonly slug: string;
  readonly environment: DeploymentEnvironment;
  readonly bundleRef: string;
  readonly bundle: ResolvedNodeArtifactBundle;
  /** Normal catalog-derived hostname, without scheme. */
  readonly publicHost: string;
}

/** Build the namespaced CR that Argo owns and the compute controller reconciles. */
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

  const namespace = `cogni-${input.environment}`;
  return {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "ComputeWorkload",
    metadata: {
      // The CRD makes this immutable and equal to spec.nodeId: one paid
      // workload per node in each environment namespace.
      name: input.bundle.nodeId,
      namespace,
      labels: {
        "cogni.io/node-id": input.bundle.nodeId,
        "cogni.io/environment": input.environment,
        "cogni.io/node": input.slug,
      },
    },
    spec: {
      nodeId: input.bundle.nodeId,
      environment: input.environment,
      bundle: {
        ref: input.bundleRef,
        source: input.bundle.source,
        artifacts: input.bundle.artifacts,
      },
      workload: { name: input.slug, publicHost: input.publicHost, services },
    },
  };
}
