// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute-crossplane/render-xakashworkload`
 * Purpose: Pure renderer that turns a node's repo-spec workload declaration into an
 *   `XAkashWorkload` composite resource (compute.cogni.io/v1alpha1). Under the
 *   Crossplane-reconcile design, the operator's ONLY compute responsibility is to
 *   render this desired-state CR into git/the cluster; Crossplane + provider-akash
 *   own reconcile, drift, retry, adoption, and delete.
 * Scope: Pure data mapping — no I/O, no k8s client, no Akash/Console calls. It does
 *   NOT import or touch the in-process ComputeWorkload controller/adapter; this is a
 *   parallel, opt-in path (see infra/crossplane/README.md "OPEN DECISION").
 * Invariants:
 *   - DETERMINISTIC: same input → byte-identical CR (stable key order via typed shape).
 *   - NODE_ID_IS_THE_KEY: `spec.nodeId` is the deterministic adoption/idempotency key the
 *     provider dedupes on; the CR name defaults to it so there is one paid workload per
 *     node/env, matching the operator's existing ComputeWorkload invariant.
 *   - NO_SECRETS: only non-secret, git-safe declaration fields are rendered.
 */

/** One service in a node workload declaration (git-safe subset of the repo-spec). */
export interface NodeWorkloadServiceDeclaration {
  readonly name: string;
  /** Fully-qualified OCI ref; digest-pinned in production. */
  readonly image: string;
  readonly cpuUnits: number;
  readonly memoryMi: number;
  readonly storageMi: number;
  readonly port: number;
  readonly visibility: "public" | "private";
}

/** A node's declarative workload, as carried by the node repo-spec. */
export interface NodeWorkloadDeclaration {
  /** Stable workload identity (uuid). Becomes spec.nodeId AND (by default) the CR name. */
  readonly nodeId: string;
  /** Public hostname the workload is served on. */
  readonly publicHost: string;
  /** Services to run (>= 1). */
  readonly services: readonly NodeWorkloadServiceDeclaration[];
  /** Optional CR name override; defaults to `nodeId`. Must be DNS-1123. */
  readonly name?: string;
  /** ProviderConfig carrying the Console credential. Defaults to "default". */
  readonly providerConfigName?: string;
}

export interface XAkashWorkloadService {
  readonly name: string;
  readonly image: string;
  readonly cpuUnits: number;
  readonly memoryMi: number;
  readonly storageMi: number;
  readonly port: number;
  readonly visibility: "public" | "private";
}

export interface XAkashWorkloadManifest {
  readonly apiVersion: "compute.cogni.io/v1alpha1";
  readonly kind: "XAkashWorkload";
  readonly metadata: { readonly name: string };
  readonly spec: {
    readonly nodeId: string;
    readonly publicHost: string;
    readonly providerConfigName: string;
    readonly services: readonly XAkashWorkloadService[];
  };
}

const DNS_1123 = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;

/**
 * Render a node workload declaration into an `XAkashWorkload` CR manifest.
 * Throws on structurally-invalid input so a bad spec fails at render time, not
 * at reconcile time.
 */
export function renderXAkashWorkload(
  decl: NodeWorkloadDeclaration
): XAkashWorkloadManifest {
  if (!decl.nodeId || decl.nodeId.trim() === "") {
    throw new Error("renderXAkashWorkload: nodeId is required");
  }
  if (!decl.publicHost || decl.publicHost.trim() === "") {
    throw new Error("renderXAkashWorkload: publicHost is required");
  }
  if (!decl.services || decl.services.length === 0) {
    throw new Error("renderXAkashWorkload: at least one service is required");
  }

  const name = decl.name ?? decl.nodeId;
  if (!DNS_1123.test(name)) {
    throw new Error(
      `renderXAkashWorkload: CR name ${JSON.stringify(name)} is not DNS-1123 (a-z, 0-9, '-')`
    );
  }

  const seen = new Set<string>();
  const services = decl.services.map((s) => {
    if (!s.name || !DNS_1123.test(s.name)) {
      throw new Error(
        `renderXAkashWorkload: service name ${JSON.stringify(s.name)} is not DNS-1123`
      );
    }
    if (seen.has(s.name)) {
      throw new Error(
        `renderXAkashWorkload: duplicate service name ${JSON.stringify(s.name)}`
      );
    }
    seen.add(s.name);
    if (!s.image || s.image.trim() === "") {
      throw new Error(`renderXAkashWorkload: service ${s.name} has no image`);
    }
    for (const [field, value] of [
      ["cpuUnits", s.cpuUnits],
      ["memoryMi", s.memoryMi],
      ["storageMi", s.storageMi],
      ["port", s.port],
    ] as const) {
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error(
          `renderXAkashWorkload: service ${s.name} field ${field} must be a positive number`
        );
      }
    }
    if (s.visibility !== "public" && s.visibility !== "private") {
      throw new Error(
        `renderXAkashWorkload: service ${s.name} visibility must be "public" or "private"`
      );
    }
    // Explicit field construction → stable key order, no leaked extras.
    return {
      name: s.name,
      image: s.image,
      cpuUnits: s.cpuUnits,
      memoryMi: s.memoryMi,
      storageMi: s.storageMi,
      port: s.port,
      visibility: s.visibility,
    };
  });

  // Akash exposes exactly one global ingress per lease, and the operator's
  // ComputeWorkload CRD enforces the same — mirror that invariant here so a bad
  // declaration fails at render time, not at reconcile time.
  const publicCount = services.filter((s) => s.visibility === "public").length;
  if (publicCount !== 1) {
    throw new Error(
      `renderXAkashWorkload: exactly one public service is required (found ${publicCount})`
    );
  }

  return {
    apiVersion: "compute.cogni.io/v1alpha1",
    kind: "XAkashWorkload",
    metadata: { name },
    spec: {
      nodeId: decl.nodeId,
      publicHost: decl.publicHost,
      providerConfigName: decl.providerConfigName ?? "default",
      services,
    },
  };
}
