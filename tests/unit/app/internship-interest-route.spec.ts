// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/internship-interest-route`
 * Purpose: Root coverage for the public signed internship submission route.
 * Scope: Exercises valid signature, tampered-message rejection, and invalid-signature rejection. Does not perform network, DB, or log shipping.
 * Invariants: Server verifies the wallet-signed message against submitted fields before Calendly handoff.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/public/internship-interest/route.ts
 * @public
 */

import { NextRequest } from "next/server";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildInternshipApplicationMessage,
  type InternshipInterestInput,
  internshipInterestOperation,
  type UnsignedInternshipInterestInput,
} from "@/contracts/internship.interest.v1.contract";

const mockServerEnv = {
  DEREK_INTERVIEW_URL: "https://calendly.com/derekg1729",
};

vi.mock("@/shared/env", () => ({
  serverEnv: () => mockServerEnv,
}));

vi.mock("@/shared/env/server-env", () => ({
  serverEnv: () => mockServerEnv,
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
      clock: { now: vi.fn(() => new Date("2026-06-02T00:00:00Z")) },
      config: {
        DEPLOY_ENVIRONMENT: "test",
        rateLimitBypass: { enabled: false, headerName: "", headerValue: "" },
        unhandledErrorPolicy: "rethrow",
      },
    })),
  };
});

describe("/api/v1/public/internship-interest signed route", () => {
  const applicant = privateKeyToAccount(
    "0x1111111111111111111111111111111111111111111111111111111111111111"
  );
  const attacker = privateKeyToAccount(
    "0x2222222222222222222222222222222222222222222222222222222222222222"
  );

  const unsignedPayload = {
    name: "Ada Lovelace",
    email: "ada@example.com",
    github: "ada-lovelace",
    artifactUrl: "https://github.com/ada-lovelace/cogni-agent",
    focus: "x402-apps",
    squadStatus: "forming",
    timezone: "Europe/London",
    weeklyAvailability: "8-10 hours per week",
    artifactNotes: "Start with the README and agent evals.",
    whyCogni: "I want to build durable agent businesses.",
    firstProjectChoice: "knowledge-capture",
    recordingConsent: true,
    note: "I want to build agent-native payment flows.",
  } satisfies UnsignedInternshipInterestInput;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function signedPayload(
    overrides: Partial<InternshipInterestInput> = {}
  ): Promise<InternshipInterestInput> {
    const walletSignedAt = "2026-06-02T00:00:00.000Z";
    const walletMessage = buildInternshipApplicationMessage({
      ...unsignedPayload,
      walletSignedAt,
    });
    const walletSignature = await applicant.signMessage({
      message: walletMessage,
    });

    return {
      ...unsignedPayload,
      walletAddress: applicant.address,
      walletMessage,
      walletSignature,
      walletSignedAt,
      ...overrides,
    };
  }

  function request(body: unknown): NextRequest {
    return new NextRequest(
      "http://localhost:3000/api/v1/public/internship-interest",
      {
        method: "POST",
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  it("returns Calendly handoff for a valid wallet-signed application", async () => {
    const { POST } = await import(
      "@/app/api/v1/public/internship-interest/route"
    );

    const response = await POST(request(await signedPayload()));
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(internshipInterestOperation.output.parse(data)).toMatchObject({
      ok: true,
      derekInterviewUrl: "https://calendly.com/derekg1729",
    });
  });

  it("rejects an application changed after signing", async () => {
    const { POST } = await import(
      "@/app/api/v1/public/internship-interest/route"
    );

    const response = await POST(
      request(await signedPayload({ whyCogni: "Changed after signing." }))
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "wallet signature does not match application",
    });
  });

  it("rejects a signature from a different wallet", async () => {
    const { POST } = await import(
      "@/app/api/v1/public/internship-interest/route"
    );
    const payload = await signedPayload();

    const response = await POST(
      request({
        ...payload,
        walletSignature: await attacker.signMessage({
          message: payload.walletMessage,
        }),
      })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "wallet signature does not match application",
    });
  });
});
