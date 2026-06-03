// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/internship-subsidy.prototype`
 * Purpose: Contract tests for the public intern subsidy prototype endpoint.
 * Scope: Validates public GET behavior, query validation, output contract, and cache headers.
 * Invariants: public access; no real protocol IO; output matches internship subsidy prototype contract.
 * Side-effects: none (facade mocked)
 * Links: src/app/api/v1/public/internship-subsidy/prototype/route.ts, src/contracts/internship.subsidy-prototype.v1.contract.ts
 * @public
 */

import { MOCK_SERVER_ENV } from "@tests/_fixtures/env/base-env";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InternshipSubsidyPrototypeOutput } from "@/contracts/internship.subsidy-prototype.v1.contract";
import { internshipSubsidyPrototypeOperation } from "@/contracts/internship.subsidy-prototype.v1.contract";

vi.mock("@/app/_facades/internship-subsidy/prototype.server", () => ({
  getInternshipSubsidyPrototypeFacade: vi.fn(),
}));

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

import { getInternshipSubsidyPrototypeFacade } from "@/app/_facades/internship-subsidy/prototype.server";
import { GET } from "@/app/api/v1/public/internship-subsidy/prototype/route";

const mockPrototype: InternshipSubsidyPrototypeOutput = {
  generatedAt: "2026-05-31T12:00:00.000Z",
  selectedRail: {
    rail: "allo",
    label: "Allo Protocol grant pool",
    fit: "recommended",
    status: "prototype",
    ossProjectUrl: "https://github.com/allo-protocol/allo-v2",
    contractSurface: ["Allo.sol", "Registry.sol"],
    cogniResponsibilities: ["Approve interview-gated milestone payments"],
    avoidedResponsibilities: ["Cogni-owned subsidy smart contract"],
    actions: [
      {
        id: "create-pool",
        label: "Create Allo pool",
        actor: "dao",
        timing: "setup",
        details: "Create a USDC pool for the intern subsidy cohort.",
      },
    ],
    riskNotes: ["Prototype only; no transaction signing."],
  },
  railOptions: [
    {
      rail: "allo",
      label: "Allo Protocol grant pool",
      fit: "recommended",
    },
    {
      rail: "sablier-flow",
      label: "Sablier Flow stream",
      fit: "viable",
    },
  ],
  program: {
    id: "intern-ai-subscription-subsidy",
    name: "Intern AI Subscription Subsidy",
    purpose: "DAO-funded USDC subsidy for AI tool subscriptions.",
    managerLegalActor: "Cogni DAO",
    cohortSize: 5,
    incrementsPerIntern: 3,
    incrementUsdCents: 20_000,
    poolAmountUsdCents: 300_000,
    asset: {
      symbol: "USDC",
      chainId: 8453,
      decimals: 6,
    },
    milestones: [
      {
        id: "interview-passed",
        sequence: 1,
        label: "Interview passed and wallet identity linked",
        gate: "interview_passed",
        amountUsdCents: 20_000,
      },
    ],
  },
};

describe("/api/v1/public/internship-subsidy/prototype contract tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the default Allo prototype without authentication", async () => {
    vi.mocked(getInternshipSubsidyPrototypeFacade).mockResolvedValue(
      mockPrototype
    );

    const request = new NextRequest(
      "http://localhost:3000/api/v1/public/internship-subsidy/prototype"
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(getInternshipSubsidyPrototypeFacade).toHaveBeenCalledWith(
      {
        rail: "allo",
        cohortSize: 5,
        incrementsPerIntern: 3,
      },
      expect.any(Object)
    );

    const parsed = internshipSubsidyPrototypeOperation.output.parse(data);
    expect(parsed.selectedRail.rail).toBe("allo");
    expect(parsed.program.poolAmountUsdCents).toBe(300_000);
  });

  it("accepts the Sablier Flow rail query", async () => {
    vi.mocked(getInternshipSubsidyPrototypeFacade).mockResolvedValue({
      ...mockPrototype,
      selectedRail: {
        ...mockPrototype.selectedRail,
        rail: "sablier-flow",
        label: "Sablier Flow stream",
        fit: "viable",
        ossProjectUrl: "https://github.com/sablier-labs/flow",
      },
    });

    const request = new NextRequest(
      "http://localhost:3000/api/v1/public/internship-subsidy/prototype?rail=sablier-flow&cohortSize=2&incrementsPerIntern=2"
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(getInternshipSubsidyPrototypeFacade).toHaveBeenCalledWith(
      {
        rail: "sablier-flow",
        cohortSize: 2,
        incrementsPerIntern: 2,
      },
      expect.any(Object)
    );
  });

  it("rejects invalid rail values", async () => {
    const request = new NextRequest(
      "http://localhost:3000/api/v1/public/internship-subsidy/prototype?rail=custom-contract"
    );

    const response = await GET(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("invalid input");
    expect(getInternshipSubsidyPrototypeFacade).not.toHaveBeenCalled();
  });

  it("sets public cache headers", async () => {
    vi.mocked(getInternshipSubsidyPrototypeFacade).mockResolvedValue(
      mockPrototype
    );

    const request = new NextRequest(
      "http://localhost:3000/api/v1/public/internship-subsidy/prototype"
    );

    const response = await GET(request);

    const cacheControl = response.headers.get("Cache-Control");
    expect(cacheControl).toContain("public");
    expect(cacheControl).toContain("max-age=60");
    expect(cacheControl).toContain("stale-while-revalidate=300");
  });
});
