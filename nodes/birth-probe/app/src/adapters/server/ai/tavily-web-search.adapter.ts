// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/tavily-web-search.adapter`
 * Purpose: Tavily API adapter implementing WebSearchCapability.
 * Scope: HTTP transport to Tavily search API. Does NOT define tool contracts.
 * Invariants:
 *   - AUTH_VIA_ADAPTER: API key resolved from config, never from context
 *   - STRUCTURED_RESULTS: Returns typed WebSearchResult
 *   - HARD_CAPS_ENFORCED_AT_TOOL_BOUNDARY: maxResults=5 max, title≤120, content≤160
 * Side-effects: IO (HTTP requests to api.tavily.com)
 * Links: TOOL_USE_SPEC.md
 * @internal
 */

import type {
  WebSearchCapability,
  WebSearchParams,
  WebSearchResult,
} from "@cogni/ai-tools";

import { EVENT_NAMES, makeLogger } from "@/shared/observability";

const logger = makeLogger({ component: "TavilyWebSearchAdapter" });

/**
 * Tavily API response shape.
 * Note: Optional fields may be null or undefined depending on request params.
 */
interface TavilySearchResponse {
  results: Array<{
    title: string;
    url: string;
    content: string;
    score?: number | null;
    raw_content?: string | null;
  }>;
  query: string;
}

/**
 * Configuration for TavilyWebSearchAdapter.
 */
export interface TavilyWebSearchConfig {
  /** Tavily API key */
  apiKey: string;
  /** Request timeout in milliseconds (default: 10000) */
  timeoutMs?: number;
}

/**
 * Tavily API adapter implementing WebSearchCapability.
 *
 * Per AUTH_VIA_ADAPTER: API key is resolved from config at construction,
 * never passed in search parameters.
 */
export class TavilyWebSearchAdapter implements WebSearchCapability {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(config: TavilyWebSearchConfig) {
    this.apiKey = config.apiKey;
    this.timeoutMs = config.timeoutMs ?? 10000;
  }

  /**
   * Execute a web search via Tavily API.
   *
   * Per HARD_CAPS_ENFORCED_AT_TOOL_BOUNDARY:
   * - maxResults capped at 5 (model request is a hint, not authority)
   * - include_raw_content always false
   * - title truncated to 120 chars
   * - content truncated to 160 chars
   */
  async search(params: WebSearchParams): Promise<WebSearchResult> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    // Hard cap: max 5 results regardless of what caller requests
    const maxResults = Math.min(params.maxResults ?? 5, 5);

    try {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: params.query,
          max_results: maxResults,
          topic: params.topic ?? "general",
          // Hard cap: never request raw content (token savings)
          include_raw_content: false,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_TAVILY_ERROR,
            dep: "tavily",
            reasonCode: "http_error",
            status: response.status,
          },
          EVENT_NAMES.ADAPTER_TAVILY_ERROR
        );
        const errorText = await response.text();
        throw new Error(`Tavily API error (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as TavilySearchResponse;

      return {
        query: data.query,
        results: data.results.map((r) => ({
          url: r.url,
          // Hard cap: title max 120 chars
          title: r.title.slice(0, 120),
          // Hard cap: content max 160 chars for token efficiency
          content: r.content?.slice(0, 160) ?? "",
          // Conditionally include optional fields to satisfy exactOptionalPropertyTypes
          ...(r.score != null && { score: r.score }),
        })),
      };
    } catch (error) {
      // Log network-level errors (timeout, DNS, connection refused, etc.)
      if (error instanceof Error && error.name === "AbortError") {
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_TAVILY_ERROR,
            dep: "tavily",
            reasonCode: "timeout",
            durationMs: this.timeoutMs,
          },
          EVENT_NAMES.ADAPTER_TAVILY_ERROR
        );
      } else if (
        error instanceof Error &&
        error.message.startsWith("Tavily API error")
      ) {
        // Already logged above, just re-throw
      } else {
        const reasonCode =
          error instanceof Error && error.message === "fetch failed"
            ? "network_error"
            : "unknown_error";
        logger.error(
          {
            event: EVENT_NAMES.ADAPTER_TAVILY_ERROR,
            dep: "tavily",
            reasonCode,
          },
          EVENT_NAMES.ADAPTER_TAVILY_ERROR
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
