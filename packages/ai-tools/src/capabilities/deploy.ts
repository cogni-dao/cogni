// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/deploy`
 * Purpose: Deploy capability interface for AI tools — typed read over the node-network's per-(env,node) deploy state, the seam the deploy brain migrates into off `.sh`/workflow_dispatch.
 * Scope: Defines the read-only v0 DeployCapability (sibling of VcsCapability). Does NOT implement transport, mutate deploy state, or provision compute (that is ComputeResourcePort).
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

// ---------------------------------------------------------------------------
// Capability interface
// ---------------------------------------------------------------------------

/**
 * Deploy capability — typed READ over the node-network's deploy state.
 *
 * Per CAPABILITY_INJECTION: implementation injected at bootstrap (the operator's ArgoDeployAdapter).
 * Per ADAPTER_SWAPPABLE: an Argo/k8s adapter for v0; the provider underneath is invisible here.
 *
 * v0 is read-only — it powers the operator's per-node deployment view (which envs a node is live in,
 * at what SHA/health) without mutating anything. The Phase-1 control verbs (deploy / retract / scale)
 * are intentionally NOT on this interface yet: they have no adapter, and an interface that only its
 * own spec implements is speculation. They land here when the read path ships and an adapter exists;
 * their shape is the phase table in docs/spec/cicd-platform-boundary.md. Promotion stays on the
 * existing `VcsCapability.dispatchCandidateFlight` seam (ARGO_IS_TRUTH — no second control plane).
 */
export interface DeployCapability {
  /** List the environments in the network with a coarse per-env rollup. */
  listEnvironments(): Promise<readonly EnvSummary[]>;

  /** Read the live deploy state for one node in one environment (sourceSha, digest, health, replicas). */
  getDeployState(params: {
    env: string;
    node: string;
  }): Promise<NodeDeployState>;
}
