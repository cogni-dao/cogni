// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec/artifact-bundle`
 * Purpose: Define and atomically resolve the source-SHA artifact bundle emitted by node CI.
 * Scope: Pure schemas and assembly. Does not read git, registries, files, or deployment state.
 * Invariants: EXACT_SERVICE_COVERAGE, EXACT_ARTIFACT_COVERAGE, ONE_SOURCE_SHA, DIGEST_PINNED, ATOMIC_OR_NOTHING.
 * Side-effects: none
 * Links: story.5016, task.5065, docs/spec/node-ci-cd-contract.md
 * @public
 */

import { z } from "zod";

import {
  extractNodeId,
  extractNodeServices,
  type NodeServiceConfig,
} from "./accessors.js";
import type { DeploymentEnvName, RepoSpec } from "./schema.js";

const sourceShaSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, "source SHA must be 40 lowercase hex characters");
const logicalNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,62}$/, "name must be a DNS-safe lowercase token");
const repositorySchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/,
    "repository must be GitHub owner/name"
  )
  .transform((repository) => repository.toLowerCase());
const digestImageSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._:-]*(?:\/[a-z0-9][a-z0-9._-]*)+@sha256:[0-9a-f]{64}$/,
    "image must be an immutable OCI sha256 digest reference"
  );

export const nodeArtifactBundleSourceSchema = z
  .object({
    repository: repositorySchema,
    sha: sourceShaSchema,
  })
  .strict();

export type NodeArtifactBundleSource = z.infer<
  typeof nodeArtifactBundleSourceSchema
>;

export const nodeArtifactBundleArtifactSchema = z
  .object({
    name: logicalNameSchema,
    image: digestImageSchema,
  })
  .strict();

export type NodeArtifactBundleArtifact = z.infer<
  typeof nodeArtifactBundleArtifactSchema
>;

export const nodeArtifactBundleServiceSchema = z
  .object({
    name: logicalNameSchema,
    /** Logical ref into this bundle's `artifacts` set. */
    artifact: logicalNameSchema,
  })
  .strict();

export type NodeArtifactBundleService = z.infer<
  typeof nodeArtifactBundleServiceSchema
>;

export const nodeArtifactBundleSchema = z
  .object({
    schema_version: z.literal(1),
    node_id: z.string().uuid(),
    source: nodeArtifactBundleSourceSchema,
    artifacts: z.array(nodeArtifactBundleArtifactSchema).min(1).max(8),
    services: z.array(nodeArtifactBundleServiceSchema).min(1).max(8),
  })
  .strict()
  .superRefine((bundle, ctx) => {
    const artifactNames = bundle.artifacts.map((artifact) => artifact.name);
    if (new Set(artifactNames).size !== artifactNames.length) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate bundle artifact names",
      });
    }

    const serviceNames = bundle.services.map((service) => service.name);
    if (new Set(serviceNames).size !== serviceNames.length) {
      ctx.addIssue({
        code: "custom",
        message: "Duplicate bundle service names",
      });
    }

    const referencedArtifacts = new Set(
      bundle.services.map((service) => service.artifact)
    );
    bundle.services.forEach((service, index) => {
      if (!artifactNames.includes(service.artifact)) {
        ctx.addIssue({
          code: "custom",
          path: ["services", index, "artifact"],
          message: `Service references missing artifact: ${service.artifact}`,
        });
      }
    });
    bundle.artifacts.forEach((artifact, index) => {
      if (!referencedArtifacts.has(artifact.name)) {
        ctx.addIssue({
          code: "custom",
          path: ["artifacts", index, "name"],
          message: `Unreferenced bundled artifact: ${artifact.name}`,
        });
      }
    });
  });

export type NodeArtifactBundle = z.infer<typeof nodeArtifactBundleSchema>;

export interface BuiltNodeArtifact {
  readonly artifact: string;
  readonly sourceSha: string;
  readonly image: string;
}

export interface ResolvedNodeServiceArtifact {
  readonly service: NodeServiceConfig;
  /** Logical ref carried into the declared workload service. */
  readonly artifact: string;
  /** Resolved only for the legacy direct-provider compatibility mapper. */
  readonly image: string;
}

export interface ResolvedNodeArtifactBundle {
  readonly nodeId: string;
  readonly source: NodeArtifactBundleSource;
  readonly artifacts: readonly NodeArtifactBundleArtifact[];
  readonly services: readonly ResolvedNodeServiceArtifact[];
}

/** Authoritative identity selected by the flight, never trusted from the bundle. */
export interface ExpectedNodeArtifactBundleIdentity {
  readonly sourceSha: string;
  readonly repository: string;
}

export function parseNodeArtifactBundle(input: unknown): NodeArtifactBundle {
  const result = nodeArtifactBundleSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      `[artifact-bundle] Invalid bundle: ${result.error.message}`
    );
  }
  return result.data;
}

/**
 * Assemble the ONE CI bundle from per-artifact digest outputs.
 *
 * The full declared set is checked before an object is returned, so a caller
 * cannot serialize a partial bundle after one matrix leg fails or goes missing.
 */
export function buildNodeArtifactBundle(input: {
  readonly spec: RepoSpec;
  readonly sourceSha: string;
  readonly repository: string;
  readonly artifacts: readonly BuiltNodeArtifact[];
}): NodeArtifactBundle {
  const services = extractNodeServices(input.spec);
  const byArtifact = new Map(
    input.artifacts.map((artifact) => [artifact.artifact, artifact] as const)
  );
  if (byArtifact.size !== input.artifacts.length) {
    throw new Error("[artifact-bundle] Duplicate built artifact identities");
  }

  const declaredArtifactNames = [
    ...new Set(services.map((service) => service.artifact.name)),
  ];
  const extra = input.artifacts.find(
    (artifact) => !declaredArtifactNames.includes(artifact.artifact)
  );
  if (extra) {
    throw new Error(
      `[artifact-bundle] Undeclared built artifact: ${extra.artifact}`
    );
  }

  const artifacts = declaredArtifactNames.map((artifactName) => {
    const built = byArtifact.get(artifactName);
    if (!built) {
      const service = services.find(
        (candidate) => candidate.artifact.name === artifactName
      );
      throw new Error(
        `[artifact-bundle] Missing artifact for service ${service?.name ?? "unknown"}: ${artifactName}`
      );
    }
    if (built.sourceSha !== input.sourceSha) {
      throw new Error(
        `[artifact-bundle] Source SHA mismatch for artifact ${built.artifact}`
      );
    }
    return { name: built.artifact, image: built.image };
  });

  return parseNodeArtifactBundle({
    schema_version: 1,
    node_id: extractNodeId(input.spec),
    source: { repository: input.repository, sha: input.sourceSha },
    artifacts,
    services: services.map((service) => ({
      name: service.name,
      artifact: service.artifact.name,
    })),
  });
}

/**
 * Resolve a CI bundle against the declaration at the same source revision.
 * Exact service+artifact equality is checked before any workload assembly.
 */
export function resolveNodeArtifactBundle(
  spec: RepoSpec,
  input: unknown,
  expected: ExpectedNodeArtifactBundleIdentity
): ResolvedNodeArtifactBundle {
  const bundle = parseNodeArtifactBundle(input);
  if (bundle.source.sha !== expected.sourceSha) {
    throw new Error(
      `[artifact-bundle] Source SHA mismatch: expected ${expected.sourceSha}, received ${bundle.source.sha}`
    );
  }
  const expectedRepository = expected.repository.toLowerCase();
  if (bundle.source.repository !== expectedRepository) {
    throw new Error(
      `[artifact-bundle] Repository mismatch: expected ${expectedRepository}, received ${bundle.source.repository}`
    );
  }
  const nodeId = extractNodeId(spec);
  if (bundle.node_id !== nodeId) {
    throw new Error(
      `[artifact-bundle] Node mismatch: expected ${nodeId}, received ${bundle.node_id}`
    );
  }

  const declaredServices = extractNodeServices(spec);
  const byService = new Map(
    bundle.services.map((service) => [service.name, service] as const)
  );
  if (bundle.services.length !== declaredServices.length) {
    throw new Error(
      `[artifact-bundle] Service coverage mismatch: declared ${declaredServices.length}, bundled ${bundle.services.length}`
    );
  }

  const declaredArtifacts = new Set(
    declaredServices.map((service) => service.artifact.name)
  );
  if (bundle.artifacts.length !== declaredArtifacts.size) {
    throw new Error(
      `[artifact-bundle] Artifact coverage mismatch: declared ${declaredArtifacts.size}, bundled ${bundle.artifacts.length}`
    );
  }
  const byArtifact = new Map(
    bundle.artifacts.map((artifact) => [artifact.name, artifact] as const)
  );

  const services = declaredServices.map((service) => {
    const bundled = byService.get(service.name);
    if (!bundled) {
      throw new Error(
        `[artifact-bundle] Missing bundled service: ${service.name}`
      );
    }
    if (bundled.artifact !== service.artifact.name) {
      throw new Error(
        `[artifact-bundle] Artifact mismatch for service ${service.name}: expected ${service.artifact.name}, received ${bundled.artifact}`
      );
    }
    const artifact = byArtifact.get(bundled.artifact);
    if (!artifact) {
      // Defensive only: bundle schema already rejects dangling refs.
      throw new Error(
        `[artifact-bundle] Missing bundled artifact: ${bundled.artifact}`
      );
    }
    return { service, artifact: artifact.name, image: artifact.image };
  });

  const extraArtifact = bundle.artifacts.find(
    (artifact) => !declaredArtifacts.has(artifact.name)
  );
  if (extraArtifact) {
    throw new Error(
      `[artifact-bundle] Undeclared bundled artifact: ${extraArtifact.name}`
    );
  }

  return {
    nodeId,
    source: bundle.source,
    artifacts: bundle.artifacts,
    services,
  };
}

/**
 * Resolve a bundle for ONE deployment environment, honoring the per-service `envs` gate
 * (story.5043) as a COMPLETE cascade so the rendered per-env manifest always satisfies the
 * XComputeWorkload XRD's two cross-reference invariants
 * (infra/crossplane/xcomputeworkload/xrd.yaml):
 *
 *   - "every bundle artifact must be used by at least one service"
 *   - "every binding must target a different declared sibling service"
 *
 * A service whose `envs` allow-list does NOT include `environment` is DROPPED. Dropping a
 * service alone is not enough (bug.5262): a naive filter leaves behind (a) any bundle artifact
 * that only the dropped service referenced — now used by no service — and (b) any `bindings`
 * entry on a REMAINING service that targeted the dropped one — now pointing at a non-declared
 * sibling. Poly's `production` lane hit exactly this: excluding the `paper-trader` sidecar left
 * an orphaned `paper-trader` artifact and the app's `PAPER_SIDECAR_URL: paper-trader` binding,
 * so the rendered prod XR was INVALID and Argo's server-side-diff dry-run refused to sync it,
 * freezing the node on a stale build. So this function also:
 *
 *   1. Drops any binding on a surviving service that targets a no-longer-declared service.
 *   2. Drops any artifact no longer referenced by any surviving service.
 *
 * PURE + BYTE-IDENTICAL-WHERE-INCLUDED: no I/O. An environment that includes every service (the
 * common case, and every service that omits `envs`) drops nothing — artifacts, services, and each
 * service's bindings are preserved unchanged (a service whose bindings need no pruning is returned
 * by reference), so this is a no-op for every ungated bundle.
 */
export function resolveNodeArtifactBundleForEnvironment(
  bundle: ResolvedNodeArtifactBundle,
  environment: DeploymentEnvName
): ResolvedNodeArtifactBundle {
  const includedServices = bundle.services.filter(
    ({ service }) =>
      service.envs === undefined || service.envs.includes(environment)
  );

  // The set of service names still declared in THIS environment. A binding may only target one
  // of these (XRD: "every binding must target a different declared sibling service").
  const declaredNames = new Set(
    includedServices.map(({ service }) => service.name)
  );

  const services = includedServices.map((resolved) => {
    const entries = Object.entries(resolved.service.bindings);
    const kept = entries.filter(([, target]) => declaredNames.has(target));
    // Preserve by reference when no binding was pruned — nothing changes for an env that
    // includes the whole topology, so an ungated bundle round-trips unchanged.
    if (kept.length === entries.length) return resolved;
    return {
      ...resolved,
      service: {
        ...resolved.service,
        bindings: Object.fromEntries(kept),
      },
    };
  });

  // An artifact survives only if some surviving service still references it (XRD: "every bundle
  // artifact must be used by at least one service"). A shared artifact referenced by another
  // included service is NOT dropped.
  const referencedArtifacts = new Set(services.map(({ artifact }) => artifact));
  const artifacts = bundle.artifacts.filter((artifact) =>
    referencedArtifacts.has(artifact.name)
  );

  return {
    nodeId: bundle.nodeId,
    source: bundle.source,
    artifacts,
    services,
  };
}
