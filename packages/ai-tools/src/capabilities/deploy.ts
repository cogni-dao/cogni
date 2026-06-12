// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/deploy`
 * Purpose: Deploy capability interface for AI tools — typed, first-class awareness + control over the
 *   node-network's deploy state. The seam the deploy brain migrates INTO, off `.sh`/workflow_dispatch.
 * Scope: Defines DeployCapability for reading (v0) and, later, controlling per-(env,node) deploy state.
 *   Does NOT implement transport. Sibling of VcsCapability (see ./vcs).
 * Invariants:
 *   - CAPABILITY_INJECTION: Implementation injected at bootstrap, not imported.
 *   - ADAPTER_SWAPPABLE: Argo/k8s adapter for v0; the interface never names a provider.
 *   - ARGO_IS_TRUTH: Reads live Argo/catalog state; it is NOT a parallel control plane. Promotion
 *     reuses the existing VcsCapability.dispatchCandidateFlight seam; Argo stays the reconciler and
 *     git stays the deploy-state truth (ci-cd.md Axioms 4 & 6).
 *   - PROVIDER_AGNOSTIC: Speaks the Argo/k8s API, so it is blind to the compute substrate underneath
 *     (Cherry today, Akash future). Compute provisioning + crypto settlement live in a separate
 *     ComputeResourcePort, never here.
 * Side-effects: none (interface only)
 * Links: docs/spec/cicd-platform-boundary.md § "The next layer: a typed operator control plane",
 *   docs/spec/mcp-control-plane.md (registry/adapter-swap pattern), PR #628 (Argo GitOps foundation)
 * @public
 */

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

/** Coarse health of a deployed node, derived from the new ReplicaSet + `/version`. */
export type NodeHealthState =
  | "healthy"
  | "degraded"
  | "provisioning"
  | "unknown";

/** Replica counts for a node's Deployment. */
export interface ReplicaCounts {
  readonly desired: number;
  readonly ready: number;
}

/** One environment in the node network (e.g. `candidate-a`, `preview`, `production`). */
export interface EnvSummary {
  readonly env: string;
  readonly nodeCount: number;
  readonly health: NodeHealthState;
}

/**
 * Live deploy state for one `(env, node)` cell, read from Argo + the deploy branch.
 *
 * `sourceSha` is the artifact source SHA recorded in `.promote-state/source-sha-by-app.json`;
 * `buildSha` is what the running pod serves at `/version.buildSha`. They match on a healthy,
 * fully-rolled deploy (ci-cd.md Axiom 19) and diverge mid-rollout.
 */
export interface NodeDeployState {
  readonly env: string;
  readonly node: string;
  readonly sourceSha: string | null;
  readonly digest: string | null;
  readonly buildSha: string | null;
  readonly health: NodeHealthState;
  readonly replicas: ReplicaCounts;
}

/**
 * Proof of a promotion. v0 wraps `VcsCapability.dispatchCandidateFlight` — there is no second
 * dispatch path. `workflowUrl` is where the caller observes the resulting run.
 */
export interface DeploymentProof {
  readonly dispatched: boolean;
  readonly env: string;
  readonly node: string;
  readonly sourceSha: string;
  readonly workflowUrl: string;
}

/** Proof of a retraction — a revert commit on the `deploy/<env>-<node>` branch (Argo reconciles). */
export interface RetractionProof {
  readonly retracted: boolean;
  readonly env: string;
  readonly node: string;
  readonly revertSha: string;
}

/** Proof of a replica scale — an overlay patch on the deploy branch. */
export interface ScaleProof {
  readonly applied: boolean;
  readonly env: string;
  readonly node: string;
  readonly replicas: number;
}

// ---------------------------------------------------------------------------
// Capability interface
// ---------------------------------------------------------------------------

/**
 * Deploy capability — typed control over the node-network's deploy state.
 *
 * Per CAPABILITY_INJECTION: implementation injected at bootstrap (the operator's ArgoDeployAdapter).
 * Per ADAPTER_SWAPPABLE: an Argo/k8s adapter for v0; the provider underneath is invisible here.
 *
 * v0 exposes only the READ surface — it powers the operator's node-network CI/CD dashboard and the
 * brain's awareness without mutating anything. The optional control verbs are Phase 1; until an
 * adapter implements them they are absent, and promotion stays on the existing flight seam.
 */
export interface DeployCapability {
  /** List the environments in the network with a coarse rollup. */
  listEnvironments(): Promise<readonly EnvSummary[]>;

  /** Read the live deploy state for one node in one environment. */
  getDeployState(params: {
    env: string;
    node: string;
  }): Promise<NodeDeployState>;

  /** Observe a node's current health + `/version.buildSha` (point read; not a stream). */
  observe(params: { env: string; node: string }): Promise<NodeDeployState>;

  /**
   * Promote a source revision into an `(env, node)` cell. Phase 1.
   *
   * v0 implementations omit this. When present it wraps `dispatchCandidateFlight` — it does NOT
   * become a second promotion primitive (ARGO_IS_TRUTH).
   */
  deployNode?(params: {
    env: string;
    node: string;
    sourceSha: string;
  }): Promise<DeploymentProof>;

  /** Roll a node back by reverting its deploy-branch tip (Argo reconciles). Phase 1. */
  retractNode?(params: { env: string; node: string }): Promise<RetractionProof>;

  /** Scale a node's replicas via an overlay patch on its deploy branch. Phase 1. */
  scaleNode?(params: {
    env: string;
    node: string;
    replicas: number;
  }): Promise<ScaleProof>;
}
