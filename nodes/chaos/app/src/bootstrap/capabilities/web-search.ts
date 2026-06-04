// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/web-search`
 * Purpose: Factory for WebSearchCapability - bridges ai-tools capability interface to TavilyWebSearchAdapter.
 * Scope: Creates WebSearchCapability from server environment. Does not implement transport.
 * Invariants:
 *   - NO_SECRETS_IN_CONTEXT: Tavily API key resolved from env, never passed to tools
 * Side-effects: none (factory only)
 * Links: Called by bootstrap container; consumed by ai-tools web-search tool.
 *        Uses TAVILY_API_KEY.
 * @internal
 */

import type { WebSearchCapability } from "@cogni/ai-tools";

import { TavilyWebSearchAdapter } from "@/adapters/server";
import { FakeWebSearchAdapter } from "@/adapters/test";
import type { ServerEnv } from "@/shared/env";

/**
 * Stub WebSearchCapability that throws when not configured.
 * Used when Tavily API key is not set.
 */
export const stubWebSearchCapability: WebSearchCapability = {
  search: async () => {
    throw new Error(
      "WebSearchCapability not configured. Set TAVILY_API_KEY environment variable."
    );
  },
};

/**
 * Create WebSearchCapability from server environment.
 * Uses TAVILY_API_KEY for Tavily API authentication.
 *
 * - APP_ENV=test: FakeWebSearchAdapter
 * - Configured: TavilyWebSearchAdapter (real Tavily API)
 * - Not configured: stub that throws on use
 *
 * @param env - Server environment with Tavily configuration
 * @returns WebSearchCapability backed by appropriate adapter
 */
export function createWebSearchCapability(env: ServerEnv): WebSearchCapability {
  // Test mode only: use FakeWebSearchAdapter
  if (env.isTestMode) {
    const fake = new FakeWebSearchAdapter();
    return { search: (p) => fake.search(p) };
  }

  const apiKey = env.TAVILY_API_KEY;

  // Not configured: stub that throws on use
  if (!apiKey) {
    return stubWebSearchCapability;
  }

  // Configured: use real Tavily API adapter
  const adapter = new TavilyWebSearchAdapter({
    apiKey,
    timeoutMs: 10000,
  });
  return { search: (p) => adapter.search(p) };
}
