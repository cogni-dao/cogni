// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/deploy`
 * Purpose: Composition seam for the read-only `DeployCapability` (the SEE flow). Wires the v0
 *   probe-backed adapter (public `serving` probe) behind the `DeployCapability` interface so the app
 *   layer never imports the adapter directly (no-restricted-imports) and the richer Argo/k8s adapter
 *   can swap in later with zero call-site change.
 * Scope: Wiring only — derive the root base domain from env, construct `ProbeDeployAdapter` with the
 *   public-surface prober. No business logic.
 * Invariants:
 *   - CAPABILITY_INJECTION: built at bootstrap; deps (prober, config) injected, no env read in the adapter.
 *   - GRACEFUL_UNWIRED: returns `undefined` when no base domain is configured (caller maps to 503),
 *     mirroring the metrics/observability capabilities.
 * Side-effects: none (factory only)
 * Links: src/adapters/server/deploy/probe-deploy.adapter.ts, src/bootstrap/node-flight.factory.ts,
 *   src/features/nodes/flight-status.ts (rootDomain), docs/design/operator-managed-deployments.md § SEE
 * @internal
 */

import { ProbeDeployAdapter } from "@/adapters/server";
import type { ServerEnv } from "@/shared/env";
import { rootDomain } from "@/shared/node-registry/deploy-hosts";
import { baseDomain } from "@/shared/node-registry/resolve";

import { createNodeProber } from "../node-flight.factory";

/** The primary node serves the env apex (test./preview./bare) rather than a slugged host. */
const PRIMARY_SLUG = "operator";

/**
 * Build the read-only `DeployCapability` for this env. v0 = probe-backed: it reuses the validated
 * public `serving` probe to answer "which envs is this node live in?". Returns `undefined` when the
 * operator has no base domain configured (DOMAIN/APP_BASE_URL unset) so the caller can 503 cleanly.
 */
export function createDeployCapability(
  env: ServerEnv
): ProbeDeployAdapter | undefined {
  const apex = baseDomain(env);
  if (!apex) return undefined;
  return new ProbeDeployAdapter(createNodeProber(), {
    baseDomain: rootDomain(apex),
    primarySlug: PRIMARY_SLUG,
  });
}
