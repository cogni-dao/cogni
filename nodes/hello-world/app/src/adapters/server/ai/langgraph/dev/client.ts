// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/langgraph/dev/client`
 * Purpose: SDK client factory for LangGraph dev server.
 * Scope: Creates @langchain/langgraph-sdk Client for connecting to langgraph dev. Does NOT manage connections or lifecycle.
 * Invariants:
 *   - OFFICIAL_SDK_ONLY: Uses official SDK, no manual SSE parsing
 *   - MVP_DEV_ONLY: Port 2024 for langgraph dev (not 8123 for docker)
 * Side-effects: none
 * Links: LANGGRAPH_SERVER.md (MVP section)
 * @internal
 */

// biome-ignore lint/style/noRestrictedImports: SDK allowed in langgraph dev adapter per OFFICIAL_SDK_ONLY invariant
import { Client } from "@langchain/langgraph-sdk";

/**
 * Configuration for LangGraph dev client.
 */
export interface LangGraphDevClientConfig {
  /** API URL for langgraph dev server (e.g., "http://localhost:2024") */
  readonly apiUrl: string;
  /** Optional API key (not needed for local dev) */
  readonly apiKey?: string;
}

/**
 * Create SDK client for LangGraph dev server.
 *
 * Per OFFICIAL_SDK_ONLY: uses @langchain/langgraph-sdk Client.
 * Per MVP_DEV_ONLY: designed for langgraph dev (port 2024).
 *
 * @param config - Client configuration
 * @returns SDK Client instance
 */
export function createLangGraphDevClient(
  config: LangGraphDevClientConfig
): Client {
  return new Client({
    apiUrl: config.apiUrl,
    ...(config.apiKey !== undefined && { apiKey: config.apiKey }),
  });
}
