// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/deploy/probe-deploy`
 * Purpose: v0 `DeployCapability` for the operator's read-only SEE flow. Answers "which envs is this
 *   node live in?" by reusing the EXISTING public `serving` probe (`/readyz` + `/version`) — no
 *   in-cluster k8s ServiceAccount, no Argo creds. This is the cheapest CORRECT path to the
 *   real-vs-junk-node distinction (a wizard-test node is live nowhere; a real one serves an env).
 * Scope: HTTP-probe orchestration behind the `DeployCapability` interface. Host derivation reuses
 *   `hostForEnv`/`FLIGHT_ENVS` from the flight-status feature; all network I/O is the injected prober.
 * Invariants:
 *   - CAPABILITY_INJECTION: prober + config injected via constructor; no env loading here.
 *   - ADAPTER_SWAPPABLE: behind `DeployCapability` so the richer Argo/k8s adapter (sourceSha, digest,
 *     true replica counts) can swap in later with zero route/UI change.
 *   - ARGO_IS_TRUTH: this is a read-only awareness surface, never a parallel control plane.
 *   - PROBE_FIDELITY: `serving` proves the public surface answers, so it yields `buildSha`, coarse
 *     `health` (serving ⇒ healthy, else unknown), and coarse `replicas` (1/1 serving, else 0/0).
 *     `sourceSha`/`digest` are NULL — a public probe cannot see the deploy branch; that enrichment is
 *     the deferred Argo adapter's job.
 * Side-effects: network I/O (via the injected prober)
 * Links: packages/ai-tools/src/capabilities/deploy.ts (the interface),
 *   src/features/nodes/flight-status.ts (hostForEnv/FLIGHT_ENVS), docs/design/operator-managed-deployments.md § SEE
 * @public
 */

import type {
  DeployCapability,
  EnvSummary,
  NodeDeployState,
  NodeHealthState,
  ReplicaCounts,
} from "@cogni/ai-tools";

import type { NodeProber, ServingResult } from "@/ports";
import {
  FLIGHT_ENVS,
  hostForEnv,
  isFlightEnv,
} from "@/shared/node-registry/deploy-hosts";

/** Static config for host derivation — injected so the adapter never reads env. */
export interface ProbeDeployConfig {
  /** Root zone the network serves under (e.g. `cognidao.org`), env subdomains stripped. */
  readonly baseDomain: string;
  /** Slug of the PRIMARY node (operator), which serves the env apex rather than a slugged host. */
  readonly primarySlug: string;
}

/** Map one `serving` rung to the coarse `NodeDeployState` fields a public probe can prove. */
function servingToState(
  env: string,
  node: string,
  serving: ServingResult
): NodeDeployState {
  const live = serving.status === "pass";
  const health: NodeHealthState = live ? "healthy" : "unknown";
  const replicas: ReplicaCounts = live
    ? { desired: 1, ready: 1 }
    : { desired: 0, ready: 0 };
  return {
    env,
    node,
    // A public probe cannot read the deploy branch; the Argo adapter enriches these.
    sourceSha: null,
    digest: null,
    buildSha: serving.buildSha,
    health,
    replicas,
  };
}

/**
 * Probe-backed `DeployCapability`. Constructed with a `NodeProber` (public-surface I/O) plus the host
 * config. `getDeployState` is the single source of truth for one `(env, node)` cell; `listEnvironments`
 * is a thin static rollup of the network's deploy envs.
 */
export class ProbeDeployAdapter implements DeployCapability {
  constructor(
    private readonly prober: NodeProber,
    private readonly config: ProbeDeployConfig
  ) {}

  async listEnvironments(): Promise<readonly EnvSummary[]> {
    // v0: a static enumeration of the deploy envs. Per-env node counts / aggregate health are an
    // Argo-adapter concern (this probe adapter is single-node-scoped); report `unknown` until then.
    return FLIGHT_ENVS.map(
      (env): EnvSummary => ({ env, nodeCount: 0, health: "unknown" })
    );
  }

  async getDeployState(params: {
    env: string;
    node: string;
  }): Promise<NodeDeployState> {
    const { env, node } = params;
    if (!isFlightEnv(env)) {
      // Unknown env ⇒ not deployed there (never throw; the SEE flow renders a clean "not deployed").
      return servingToState(env, node, {
        status: "fail",
        readyzCode: 0,
        buildSha: null,
      });
    }
    const host = hostForEnv(
      node,
      node === this.config.primarySlug,
      env,
      this.config.baseDomain
    );
    const serving = await this.prober.serving(host);
    return servingToState(env, node, serving);
  }
}
