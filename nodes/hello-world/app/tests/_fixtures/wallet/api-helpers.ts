// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/wallet/api-helpers`
 * Purpose: Helper functions for wallet link API testing.
 * Scope: Provides reusable fetch wrappers for wallet link endpoint tests. Does not contain validation logic or test assertions.
 * Invariants: DRY helpers for stack tests
 * Side-effects: IO (HTTP requests in test environment)
 * Notes: Reduces duplication in stack tests
 * Links: Used by stack tests for /api/v1/wallet/link
 * @public
 */

const API_BASE = process.env.TEST_BASE_URL ?? "http://localhost:3000";

export interface WalletLinkRequest {
  address: string;
}

export interface WalletLinkResponse {
  accountId: string;
  apiKey: string;
}

export interface ErrorResponse {
  error: string;
  details?: unknown;
}

/**
 * Call POST /api/v1/wallet/link with valid JSON
 */
export async function callWalletLink(address: string): Promise<Response> {
  return fetch(`${API_BASE}/api/v1/wallet/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ address }),
  });
}

/**
 * Call POST /api/v1/wallet/link with custom body (for error tests)
 */
export async function callWalletLinkRaw(body: unknown): Promise<Response> {
  const bodyString = typeof body === "string" ? body : JSON.stringify(body);

  return fetch(`${API_BASE}/api/v1/wallet/link`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: bodyString,
  });
}
