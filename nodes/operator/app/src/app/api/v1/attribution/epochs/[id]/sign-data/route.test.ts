// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getEpoch = vi.fn();
const info = vi.fn();
const warn = vi.fn();
const error = vi.fn();

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ attributionStore: { getEpoch } }),
}));
vi.mock("@/bootstrap/http", () => ({
  wrapRouteHandlerWithLogging:
    (_config: unknown, handler: (...args: unknown[]) => Promise<Response>) =>
    (request: Request, context: unknown) =>
      handler(
        {
          reqId: "req-sign-data",
          routeId: "ledger.sign-data",
          log: { info, warn, error },
        },
        request,
        { walletAddress: "0x1111111111111111111111111111111111111111" },
        context
      ),
}));

async function get(id: string): Promise<Response> {
  const { GET } = await import("./route");
  return GET(
    new Request(
      `https://operator.example/api/v1/attribution/epochs/${id}/sign-data`
    ) as NextRequest,
    { params: Promise.resolve({ id }) }
  );
}

describe("GET /api/v1/attribution/epochs/[id]/sign-data observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEpoch.mockResolvedValue(null);
  });

  it("emits one privacy-safe terminal for an invalid epoch id", async () => {
    const response = await get("not-a-number");

    expect(response.status).toBe(400);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      event: "ledger.sign_data.complete",
      reqId: "req-sign-data",
      routeId: "ledger.sign-data",
      status: 400,
      outcome: "error",
      errorCode: "invalid_epoch_id",
      reasonCode: "invalid_epoch_id",
    });
  });

  it("does not log the epoch id when the epoch is missing", async () => {
    const response = await get("42");

    expect(response.status).toBe(404);
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      event: "ledger.sign_data.complete",
      status: 404,
      errorCode: "epoch_not_found",
      reasonCode: "epoch_not_found",
    });
    expect(payload).not.toHaveProperty("epochId");
    expect(JSON.stringify(payload)).not.toContain("42");
  });
});
