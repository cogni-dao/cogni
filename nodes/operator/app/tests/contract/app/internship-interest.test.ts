// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/internship-interest`
 * Purpose: Contract tests for /api/v1/public/internship-interest endpoint.
 * Scope: Validates public POST behavior, contract compliance, cache headers, and applicant PII non-echo. Does NOT test log shipping.
 * Invariants: Valid payload returns 201; malformed or invalid payload returns 400; success output matches contract and omits submitted applicant details.
 * Side-effects: none
 * Notes: Uses mocked rate limiter to avoid shared bucket state in contract tests.
 * Links: src/app/api/v1/public/internship-interest/route.ts, src/contracts/internship.interest.v1.contract.ts
 * @public
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type InternshipInterestInput,
  internshipInterestOperation,
} from "@/contracts/internship.interest.v1.contract";

vi.mock("@/shared/env", () => ({
  serverEnv: () => MOCK_SERVER_ENV,
}));
vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => MOCK_SERVER_ENV,
}));

vi.mock("@/bootstrap/http/rateLimiter", () => ({
  publicApiLimiter: {
    consume: vi.fn(() => true),
  },
  extractClientIp: vi.fn(() => "test-ip"),
  TokenBucketRateLimiter: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => {
  const childLogger = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  const log = {
    child: vi.fn(() => childLogger),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };

  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-05-19T00:00:00Z")) },
      config: {
        DEPLOY_ENVIRONMENT: "test",
        rateLimitBypass: { enabled: false, headerName: "", headerValue: "" },
        unhandledErrorPolicy: "rethrow",
      },
    })),
  };
});

import { POST } from "@/app/api/v1/public/internship-interest/route";

describe("/api/v1/public/internship-interest contract tests", () => {
  const validPayload = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    github: "ada-lovelace",
    focus: "x402-apps",
    squadStatus: "forming",
    note: "I want to build agent-native payment flows.",
  } satisfies InternshipInterestInput;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makePostRequest(body: string): NextRequest {
    return new NextRequest(
      "http://localhost:3000/api/v1/public/internship-interest",
      {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  it("returns contract-valid output for a valid interest submission", async () => {
    const response = await POST(makePostRequest(JSON.stringify(validPayload)));
    const data = await response.json();

    expect(response.status).toBe(201);

    const parsed = internshipInterestOperation.output.parse(data);
    expect(parsed.ok).toBe(true);
    expect(parsed.referenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("returns 400 for malformed JSON", async () => {
    const response = await POST(makePostRequest("{"));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({ error: "invalid JSON body" });
  });

  it("returns 400 for contract-invalid input", async () => {
    const response = await POST(
      makePostRequest(
        JSON.stringify({
          ...validPayload,
          email: "not-an-email",
        })
      )
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("invalid input");
    expect(data.issues).toEqual(expect.any(Array));
  });

  it("does not echo submitted applicant details on success", async () => {
    const response = await POST(makePostRequest(JSON.stringify(validPayload)));
    const responseText = await response.text();

    expect(response.status).toBe(201);
    expect(responseText).not.toContain(validPayload.name);
    expect(responseText).not.toContain(validPayload.email);
    expect(responseText).not.toContain(validPayload.github);
    expect(responseText).not.toContain(validPayload.note);
  });

  it("sets non-cacheable public cache headers on successful submissions", async () => {
    const response = await POST(makePostRequest(JSON.stringify(validPayload)));

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, stale-while-revalidate=0"
    );
  });
});
