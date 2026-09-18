// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/compute`
 * Purpose: Factory for ComputeResourcePort — the app's provider balance READ surface
 *   (Cherry today). Akash is deliberately absent: the app holds no Console credential.
 * Scope: Creates ComputeResourcePort from ServerEnv. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: CHERRY_AUTH_TOKEN resolved from env here, never passed to tools.
 *   - CAPABILITY_INJECTION: constructed at bootstrap, injected via the container.
 *   - GRACEFUL_DEGRADATION: unconfigured → empty-balance stub (build stays green; the awareness
 *     surface simply observes zero accounts) until the token reaches the operator runtime via ESO.
 *   - ONE_CONSOLE_KEY_PER_ACCOUNT (task.5138, hub `akash-actuator-wallet-cutover`): the app
 *     NEVER constructs an Akash Console client. The account's one key lives with its actuator
 *     (`cogni/<env>/akash-tx-actuator/*`); the app's Akash view is the actuator's own ledger
 *     (`/api/v1/compute/balances` akashSpend, LeaseReadCapability), never a second credential.
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
 * - CHERRY_AUTH_TOKEN set: Cherry billing read.
 * - Unset: empty-balance stub (graceful degradation).
 */
export function createComputeCapability(env: ServerEnv): ComputeResourcePort {
  if (!env.CHERRY_AUTH_TOKEN) return stubComputeCapability;
  return new CherryComputeAdapter({
    authToken: env.CHERRY_AUTH_TOKEN,
    timeoutMs: env.COMPUTE_BALANCE_QUERY_TIMEOUT_MS,
  });
}
