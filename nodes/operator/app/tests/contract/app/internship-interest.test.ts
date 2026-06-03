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

import { generateTestWallet } from "@tests/_fixtures/auth/siwe-helpers";
import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInternshipApplicationMessage,
  type InternshipInterestInput,
  internshipInterestOperation,
  type UnsignedInternshipInterestInput,
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
  const wallet = generateTestWallet("internship-interest-contract");
  const unsignedPayload = {
    email: "ada@example.com",
    portfolioUrl: "https://github.com/ada-lovelace/cogni-agent",
    focus: "x402-apps",
    interest: "Yes. I want to build agent-native payment flows.",
  } satisfies UnsignedInternshipInterestInput;

  async function validPayload(
    overrides: Partial<InternshipInterestInput> = {}
  ): Promise<InternshipInterestInput> {
    const walletSignedAt = "2026-05-19T00:00:00.000Z";
    const walletMessage = buildInternshipApplicationMessage({
      ...unsignedPayload,
      walletSignedAt,
    });
    const walletSignature = await wallet.account.signMessage({
      message: walletMessage,
    });

    return {
      ...unsignedPayload,
      walletAddress: wallet.account.address,
      walletMessage,
      walletSignature,
      walletSignedAt,
      ...overrides,
    };
  }

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
    const response = await POST(
      makePostRequest(JSON.stringify(await validPayload()))
    );
    const data = await response.json();

    expect(response.status).toBe(201);

    const parsed = internshipInterestOperation.output.parse(data);
    expect(parsed.ok).toBe(true);
    expect(parsed.referenceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
    expect(parsed.derekInterviewUrl).toBe("https://calendly.com/derekg1729");
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
          ...(await validPayload()),
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
    const payload = await validPayload();
    const response = await POST(makePostRequest(JSON.stringify(payload)));
    const responseText = await response.text();

    expect(response.status).toBe(201);
    expect(responseText).not.toContain(payload.email);
    expect(responseText).not.toContain(payload.portfolioUrl);
    expect(responseText).not.toContain(payload.interest);
    expect(responseText).not.toContain(payload.walletAddress);
    expect(responseText).not.toContain(payload.walletSignature);
  });

  it("sets non-cacheable public cache headers on successful submissions", async () => {
    const response = await POST(
      makePostRequest(JSON.stringify(await validPayload()))
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("Cache-Control")).toBe(
      "public, max-age=0, stale-while-revalidate=0"
    );
  });

  it("returns 400 when the wallet message no longer matches the application", async () => {
    const response = await POST(
      makePostRequest(
        JSON.stringify(
          await validPayload({
            interest: "Tampered after signing.",
          })
        )
      )
    );
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({
      error: "wallet signature does not match application",
    });
  });

  it("returns 400 when the signature was produced by a different wallet", async () => {
    const attacker = generateTestWallet("internship-interest-attacker");
    const payload = await validPayload({
      walletSignature: await attacker.account.signMessage({
        message: buildInternshipApplicationMessage({
          ...unsignedPayload,
          walletSignedAt: "2026-05-19T00:00:00.000Z",
        }),
      }),
    });

    const response = await POST(makePostRequest(JSON.stringify(payload)));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data).toEqual({
      error: "wallet signature does not match application",
    });
  });
});
