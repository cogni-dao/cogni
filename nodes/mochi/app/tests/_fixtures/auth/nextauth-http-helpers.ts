// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/auth/nextauth-http-helpers`
 * Purpose: HTTP helpers for testing NextAuth flows over the network.
 * Scope: Provides utilities for CSRF token retrieval, SIWE login, and session cookie management. Does not contain test assertions.
 * Invariants: All requests use fetch() for real HTTP calls; session cookies are preserved across requests
 * Side-effects: IO (HTTP requests to NextAuth endpoints)
 * Notes: Use for stack tests exercising NextAuth flows end-to-end; Uses undici's fetch for Set-Cookie on redirects
 * Links: tests/stack/auth/, docs/spec/security-auth.md
 * @public
 */

import { CHAIN_ID } from "@cogni/node-shared";
// Use undici's fetch to access Set-Cookie headers on redirect responses
// Native fetch strips Set-Cookie from redirect: "manual" responses per Fetch API spec
import type { Response as UndiciResponse } from "undici";
import { fetch } from "undici";
import type { TestWallet } from "./siwe-helpers";
import { createAndSignSiweMessage } from "./siwe-helpers";

export interface NextAuthSessionCookie {
  name: string;
  value: string;
}

export interface CsrfTokenResult {
  csrfToken: string;
  csrfCookie: string;
}

interface CsrfResponse {
  csrfToken: string;
}

interface AuthCallbackErrorResponse {
  error: string;
}

/**
 * Get CSRF token from NextAuth /api/auth/csrf endpoint
 * Returns both the token (from JSON body) and the cookie (from Set-Cookie header)
 */
export async function getCsrfToken(baseUrl: string): Promise<CsrfTokenResult> {
  const response = await fetch(`${baseUrl}/api/auth/csrf`);
  if (!response.ok) {
    throw new Error(
      `Failed to get CSRF token: ${response.status} ${response.statusText}`
    );
  }

  const data = (await response.json()) as CsrfResponse;

  // Extract CSRF cookie from Set-Cookie header
  const setCookieHeader = response.headers.get("set-cookie");
  if (!setCookieHeader) {
    throw new Error("No Set-Cookie header in CSRF response");
  }

  const csrfCookieRegex = /next-auth\.csrf-token=([^;]+)/;
  const csrfCookieMatch = csrfCookieRegex.exec(setCookieHeader);
  if (!csrfCookieMatch) {
    throw new Error("CSRF cookie not found in Set-Cookie header");
  }

  const csrfCookie = `next-auth.csrf-token=${csrfCookieMatch[1]}`;

  return {
    csrfToken: data.csrfToken,
    csrfCookie,
  };
}

/**
 * Extract session cookie from response headers
 * Uses getSetCookie() to access Set-Cookie headers even in redirect responses
 */
export function extractSessionCookie(
  response: UndiciResponse
): NextAuthSessionCookie | null {
  // Use getSetCookie() to get all Set-Cookie headers (works with redirects)
  const setCookieHeaders = response.headers.getSetCookie
    ? response.headers.getSetCookie()
    : [];

  // Fallback to get() if getSetCookie not available
  if (setCookieHeaders.length === 0) {
    const singleHeader = response.headers.get("set-cookie");
    if (singleHeader) {
      setCookieHeaders.push(singleHeader);
    }
  }

  // NextAuth uses different cookie names in dev vs prod:
  // - dev: next-auth.session-token
  // - prod: __Secure-next-auth.session-token or next-auth.session-token
  const sessionCookieRegex =
    /(next-auth\.session-token|__Secure-next-auth\.session-token)=([^;]+)/;

  for (const cookieHeader of setCookieHeaders) {
    const sessionCookieMatch = sessionCookieRegex.exec(cookieHeader);
    if (sessionCookieMatch) {
      return {
        name: sessionCookieMatch[1] ?? "next-auth.session-token",
        value: sessionCookieMatch[2] ?? "",
      };
    }
  }

  return null;
}

export interface SiweLoginParams {
  baseUrl: string;
  wallet: TestWallet;
  domain: string;
  chainId?: number;
}

export interface SiweLoginResult {
  success: boolean;
  sessionCookie: NextAuthSessionCookie | null;
  error?: string;
}

/**
 * Perform SIWE login flow and return session cookie
 *
 * Steps:
 * 1. Get CSRF token
 * 2. Create and sign SIWE message
 * 3. POST to NextAuth credentials callback
 * 4. Extract session cookie from response
 *
 * Note: Success is determined by HTTP status (2xx/3xx) and absence of NextAuth error.
 * Uses undici's fetch to access Set-Cookie headers on redirect responses.
 */
export async function siweLogin(
  params: SiweLoginParams
): Promise<SiweLoginResult> {
  try {
    // Step 1: Get CSRF token AND cookie (must send cookie back to NextAuth)
    const { csrfToken, csrfCookie } = await getCsrfToken(params.baseUrl);

    // Step 2: Create and sign SIWE message
    const { message, signature } = await createAndSignSiweMessage(
      {
        domain: params.domain,
        address: params.wallet.account.address,
        nonce: csrfToken,
        chainId: params.chainId ?? CHAIN_ID,
      },
      params.wallet
    );

    // Step 3: POST to NextAuth credentials callback
    // CRITICAL: Must send CSRF cookie back (behave like a browser)
    // Provider ID is "credentials" (not "siwe") — matches auth.ts Credentials({ id: "credentials" })
    const callbackUrl = `${params.baseUrl}/api/auth/callback/credentials`;

    const body = new URLSearchParams({
      csrfToken,
      callbackUrl: params.baseUrl,
      json: "true", // Request JSON response
      message,
      signature,
    });

    const response = await fetch(callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        // Send CSRF cookie back (NextAuth validates this matches the token)
        Cookie: csrfCookie,
      },
      body: body.toString(),
      redirect: "manual", // Don't follow redirects - session cookie is in 302 response
    });

    // Check if login failed (NextAuth returns errors in JSON or 4xx status)
    if (response.status >= 400) {
      return {
        success: false,
        sessionCookie: null,
        error: `NextAuth callback failed with status ${response.status}`,
      };
    }

    if (response.headers.get("content-type")?.includes("application/json")) {
      const data = (await response.json()) as AuthCallbackErrorResponse;
      if (data.error) {
        return {
          success: false,
          sessionCookie: null,
          error: data.error,
        };
      }
    }

    // Step 4: Try to extract session cookie (may fail due to Fetch API restrictions)
    const sessionCookie = extractSessionCookie(response);

    // Success determined by HTTP semantics, not cookie extraction
    // 2xx/3xx with no error body = NextAuth accepted the SIWE signature
    return {
      success: true,
      sessionCookie,
      // Note: sessionCookie may be null due to Fetch API redirect restrictions
    };
  } catch (error) {
    return {
      success: false,
      sessionCookie: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Get session data from NextAuth /api/auth/session endpoint
 */
export async function getSession(
  baseUrl: string,
  sessionCookie: NextAuthSessionCookie | null
): Promise<unknown> {
  const headers: HeadersInit = {};

  if (sessionCookie) {
    headers.Cookie = `${sessionCookie.name}=${sessionCookie.value}`;
  }

  const response = await fetch(`${baseUrl}/api/auth/session`, { headers });

  if (!response.ok) {
    throw new Error(
      `Failed to get session: ${response.status} ${response.statusText}`
    );
  }

  return response.json();
}
