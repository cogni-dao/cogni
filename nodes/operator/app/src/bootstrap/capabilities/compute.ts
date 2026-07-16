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
 *   - CACHE_IS_CONTAINER_SINGLETON: the balance read is wrapped in a short-TTL single-flight cache
 *     built ONCE here and shared via the singleton container, so N viewers × tabs × refetch collapse
 *     to ≤1 Cherry `/teams` call per TTL window globally (the dashboard cannot storm Cherry).
 * Side-effects: none (factory only)
 * Links: CherryComputeAdapter (@/adapters/server), ComputeResourcePort (@cogni/ai-tools),
 *   src/shared/cache/ttl-single-flight.ts, src/bootstrap/capabilities/node-registry.ts (same pattern).
 * @internal
 */

import type { ComputeBalance, ComputeResourcePort } from "@cogni/ai-tools";

import { CherryComputeAdapter } from "@/adapters/server";
import { ttlSingleFlight } from "@/shared/cache/ttl-single-flight";
import type { ServerEnv } from "@/shared/env";

/**
 * Default balance-snapshot freshness. Cherry credit moves slowly (a billing balance), so a 60s
 * window is plenty fresh for an awareness dashboard while bounding upstream to ≤1 call/min globally.
 */
const DEFAULT_BALANCES_TTL_MS = 60_000;

/**
 * Stub ComputeResourcePort used when no provider is configured.
 * Returns no balances rather than throwing — a missing token is a not-yet-wired
 * runtime secret, not a caller error; the emitter just reports zero accounts.
 */
export const stubComputeCapability: ComputeResourcePort = {
  balances: async () => [],
};

/**
 * Wrap a ComputeResourcePort so `balances()` is served from a short-TTL, single-flight cache.
 * Balances are per-account/global (one Cherry team set), so a SINGLE cache key is correct: concurrent
 * and repeat callers within the TTL share one in-flight `/teams` read and the last-good snapshot.
 * The cache is created once per port instance and — because the port lives on the singleton container
 * — is shared across all requests (dashboard refetch, the balances route, the AI compute tool).
 */
function withCachedBalances(
  inner: ComputeResourcePort,
  ttlMs: number
): ComputeResourcePort {
  const cache = ttlSingleFlight<readonly ComputeBalance[]>({
    ttlMs,
    compute: () => inner.balances(),
  });
  return { balances: () => cache.get() };
}

/**
 * Create ComputeResourcePort from server environment.
 *
 * - CHERRY_AUTH_TOKEN set: cached CherryComputeAdapter (real Cherry billing read, ≤1 `/teams` call
 *   per TTL window globally).
 * - Not set: empty-balance stub (graceful degradation; no caching needed — it never does IO).
 */
export function createComputeCapability(
  env: ServerEnv,
  ttlMs: number = DEFAULT_BALANCES_TTL_MS
): ComputeResourcePort {
  const authToken = env.CHERRY_AUTH_TOKEN;
  if (!authToken) {
    return stubComputeCapability;
  }
  return withCachedBalances(
    new CherryComputeAdapter({
      authToken,
      timeoutMs: env.COMPUTE_BALANCE_QUERY_TIMEOUT_MS,
    }),
    ttlMs
  );
}
