// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/compute`
 * Purpose: Factory for ComputeResourcePort (read half) — bridges the ai-tools capability
 *   interface to the CherryComputeAdapter using server environment credentials.
 * Scope: Creates ComputeResourcePort from ServerEnv. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: CHERRY_AUTH_TOKEN resolved from env here, never passed to tools.
 *   - CAPABILITY_INJECTION: constructed at bootstrap, injected via the container.
 *   - GRACEFUL_DEGRADATION: unconfigured → empty-balance stub (build stays green; the scheduled
 *     emitter simply observes zero accounts) until CHERRY_AUTH_TOKEN reaches the operator runtime.
 * Side-effects: none (factory only)
 * Links: CherryComputeAdapter (@/adapters/server), ComputeResourcePort (@cogni/ai-tools).
 * @internal
 */

import type { ComputeResourcePort } from "@cogni/ai-tools";

import { CherryComputeAdapter } from "@/adapters/server";
import type { ServerEnv } from "@/shared/env";

/**
 * Stub ComputeResourcePort used when no provider is configured.
 * Returns no balances rather than throwing — a missing token is a not-yet-wired
 * runtime secret, not a caller error; the emitter just reports zero accounts.
 */
export const stubComputeCapability: ComputeResourcePort = {
  balances: async () => [],
};

/**
 * Create ComputeResourcePort from server environment.
 *
 * - CHERRY_AUTH_TOKEN set: CherryComputeAdapter (real Cherry billing read).
 * - Not set: empty-balance stub (graceful degradation).
 */
export function createComputeCapability(env: ServerEnv): ComputeResourcePort {
  const authToken = env.CHERRY_AUTH_TOKEN;
  if (!authToken) {
    return stubComputeCapability;
  }
  return new CherryComputeAdapter({
    authToken,
    timeoutMs: env.COMPUTE_BALANCE_QUERY_TIMEOUT_MS,
  });
}
