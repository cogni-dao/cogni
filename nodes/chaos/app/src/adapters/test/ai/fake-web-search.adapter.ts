// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/test/ai/fake-web-search.adapter`
 * Purpose: Fake web search adapter for testing.
 * Scope: Returns deterministic mock results. Does NOT make HTTP requests.
 * Invariants:
 *   - DETERMINISTIC_RESULTS: Always returns same structure for same query
 *   - NO_NETWORK: Never makes actual HTTP requests
 * Side-effects: none
 * Links: TOOL_USE_SPEC.md
 * @internal
 */

import type {
  WebSearchCapability,
  WebSearchParams,
  WebSearchResult,
} from "@cogni/ai-tools";

/**
 * Fake web search adapter for testing.
 *
 * Returns deterministic mock results without making HTTP requests.
 */
export class FakeWebSearchAdapter implements WebSearchCapability {
  private callCount = 0;

  /**
   * Execute a fake web search.
   * Returns deterministic mock results based on query.
   */
  async search(params: WebSearchParams): Promise<WebSearchResult> {
    this.callCount++;
    const maxResults = params.maxResults ?? 5;

    // Generate deterministic mock results
    // Use conditional spread for optional fields to satisfy exactOptionalPropertyTypes
    const results = Array.from({ length: Math.min(maxResults, 3) }, (_, i) => ({
      title: `Mock Result ${i + 1} for "${params.query}"`,
      url: `https://example.com/result-${i + 1}`,
      content: `This is mock content for search result ${i + 1} matching query "${params.query}".`,
      score: 0.9 - i * 0.1,
      ...(params.includeRawContent && {
        rawContent: `<html><body>Full content for result ${i + 1}</body></html>`,
      }),
    }));

    return {
      query: params.query,
      results,
    };
  }

  /**
   * Get the number of times search() was called.
   * Useful for testing.
   */
  getCallCount(): number {
    return this.callCount;
  }

  /**
   * Reset the call counter.
   */
  resetCallCount(): void {
    this.callCount = 0;
  }
}
