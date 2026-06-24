// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  CherryComputeAdapter,
  CherryComputeError,
} from "./cherry-compute.adapter";

const BASE = "https://api.cherryservers.com/v1";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeAdapter(fetchImpl: typeof fetch): CherryComputeAdapter {
  return new CherryComputeAdapter({
    authToken: "cherry-token",
    timeoutMs: 1000,
    fetchImpl,
  });
}

describe("CherryComputeAdapter", () => {
  it("maps a team's account credit to a provider-agnostic ComputeBalance", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(String(url)).toBe(`${BASE}/teams`);
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer cherry-token"
      );
      return jsonResponse([
        { id: 42, credit: { account: { remaining: 12.5, currency: "EUR" } } },
      ]);
    });

    const balances = await makeAdapter(fetchImpl).balances();

    expect(balances).toHaveLength(1);
    expect(balances[0]).toMatchObject({
      provider: "cherry",
      accountId: "42",
      currency: "EUR",
      remaining: 12.5,
      estimatedDaysRemaining: null,
    });
    expect(typeof balances[0]?.asOf).toBe("string");
  });

  it("skips teams without an account credit (no balance to report)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse([{ id: 1 }, { id: 2, credit: {} }])
    );
    const balances = await makeAdapter(fetchImpl).balances();
    expect(balances).toEqual([]);
  });

  it("throws CherryComputeError(HTTP_ERROR) on a non-ok response (fail loud)", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ error: "unauthorized" }, 401)
    );
    await expect(makeAdapter(fetchImpl).balances()).rejects.toBeInstanceOf(
      CherryComputeError
    );
  });

  it("throws CherryComputeError(UNEXPECTED_SHAPE) when /teams is not an array", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ not: "an array" })
    );
    await expect(makeAdapter(fetchImpl).balances()).rejects.toMatchObject({
      code: "UNEXPECTED_SHAPE",
    });
  });
});
