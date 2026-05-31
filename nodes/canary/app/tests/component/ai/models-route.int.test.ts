// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/ai/models-route.int`
 * Purpose: Validates /api/v1/ai/models HTTP endpoint behavior including auth and error handling.
 * Scope: Tests HTTP status codes and response schema compliance. Does not test cache implementation or upstream fetch logic.
 * Invariants: Route requires authentication; returns contract-valid response; handles errors gracefully; defaults computed from ModelCatalogPort.
 * Side-effects: none (fully mocked)
 * Links: /api/v1/ai/models route, ai.models.v1.contract
 * @internal
 */

import { aiModelsOperation } from "@cogni/node-contracts";
import {
  createModelsWithFree,
  loadModelsFixture,
} from "@tests/_fixtures/ai/fixtures";
import { generateTestWallet } from "@tests/_fixtures/auth/db-helpers";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock dependencies
vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn(),
}));

vi.mock("@cogni/ids", () => ({
  toUserId: vi.fn((id: string) => id),
}));

const mockModelCatalog = {
  listModels: vi.fn(),
};

const mockAccountService = {
  getOrCreateBillingAccountForUser: vi.fn(),
  getBalance: vi.fn(),
  getBillingAccount: vi.fn(),
  recordChargeReceipt: vi.fn(),
  listChargeReceipts: vi.fn(),
  getBalanceHistory: vi.fn(),
};

vi.mock("@/bootstrap/container", () => ({
  getContainer: vi.fn(() => ({
    log: {
      child: vi.fn().mockReturnThis(),
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
    },
    config: { unhandledErrorPolicy: "rethrow" },
    accountsForUser: vi.fn(() => mockAccountService),
    modelCatalog: mockModelCatalog,
  })),
}));

vi.mock("@/lib/auth/mapping", () => ({
  getOrCreateBillingAccountForUser: vi.fn().mockResolvedValue({
    id: "ba-test",
    ownerUserId: "test-user",
    defaultVirtualKeyId: "vk-test",
  }),
}));

// Import after mocks
import { getSessionUser } from "@/app/_lib/auth/session";
import { GET } from "@/app/api/v1/ai/models/route";

describe("/api/v1/ai/models component tests", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return 200 with contract-valid response when authenticated", async () => {
    const catalogResult = loadModelsFixture();

    vi.mocked(getSessionUser).mockResolvedValue({
      id: "test-user",
      walletAddress: generateTestWallet("models-route-happy-path"),
    });
    mockModelCatalog.listModels.mockResolvedValue(catalogResult);

    const req = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const response = await GET(req);
    const data = await response.json();

    expect(response.status).toBe(200);

    const parsed = aiModelsOperation.output.parse(data);
    expect(parsed.defaultRef).toBeTruthy();

    if (parsed.defaultRef) {
      const match = parsed.models.find(
        (m) =>
          m.ref.providerKey === parsed.defaultRef?.providerKey &&
          m.ref.modelId === parsed.defaultRef?.modelId
      );
      expect(match).toBeDefined();
    }
  });

  it("should return 200 with null-safe defaults when catalog has no tagged models", async () => {
    const catalogResult = createModelsWithFree();

    vi.mocked(getSessionUser).mockResolvedValue({
      id: "test-user",
      walletAddress: generateTestWallet("models-route-no-tags"),
    });
    mockModelCatalog.listModels.mockResolvedValue(catalogResult);

    const req = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const response = await GET(req);
    const data = await response.json();

    expect(response.status).toBe(200);
    const parsed = aiModelsOperation.output.parse(data);
    expect(parsed.models.length).toBeGreaterThan(0);
  });

  it("should return 401 when not authenticated", async () => {
    vi.mocked(getSessionUser).mockResolvedValue(null);

    const req = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const response = await GET(req);

    expect(response.status).toBe(401);
  });

  it("should return 503 when catalog fails", async () => {
    vi.mocked(getSessionUser).mockResolvedValue({
      id: "test-user",
      walletAddress: generateTestWallet("models-route-cache-fail"),
    });
    mockModelCatalog.listModels.mockRejectedValue(new Error("Catalog error"));

    const req = new NextRequest("http://localhost:3000/api/v1/ai/models");
    const response = await GET(req);

    expect(response.status).toBe(503);
  });
});
