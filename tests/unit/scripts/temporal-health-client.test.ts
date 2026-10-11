// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/scripts/temporal-health-client`
 * Purpose: Prove strict exit semantics and stable one-command diagnostic reasons.
 * Scope: Pure/mocked client checks only. Does not perform network IO.
 * Invariants: Only HTTP-ok healthy payloads pass; future probe failures have stable codes.
 * Side-effects: none
 * Links: scripts/lib/temporal-health-client.mjs, task.5238
 * @internal
 */

import { describe, expect, it, vi } from "vitest";
import {
  defaultBaseUrl,
  readTemporalHealth,
  TEMPORAL_HEALTH_CLI_REASON,
} from "../../../scripts/lib/temporal-health-client.mjs";

describe("Temporal health CLI client", () => {
  it("resolves canonical operator and node deployment hosts", () => {
    expect(defaultBaseUrl("operator", "candidate-a")).toBe(
      "https://test.cognidao.org"
    );
    expect(defaultBaseUrl("operator", "production")).toBe(
      "https://cognidao.org"
    );
    expect(defaultBaseUrl("poly", "preview")).toBe(
      "https://poly-preview.cognidao.org"
    );
  });

  it("passes only a successful healthy response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "healthy", reason: "ok" }), {
        status: 200,
      })
    );

    const result = await readTemporalHealth({
      baseUrl: "https://test.cognidao.org",
      apiKey: "secret",
      fetchImpl,
    });

    expect(result.exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://test.cognidao.org/api/v1/temporal/health",
      expect.objectContaining({
        headers: { Authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      })
    );
  });

  it.each([
    [503, { status: "unhealthy", reason: "activity_poller_stale" }],
    [200, { status: "unhealthy", reason: "worker_identity_invalid" }],
  ])("fails closed for HTTP %s payload %#", async (status, body) => {
    const result = await readTemporalHealth({
      baseUrl: "https://node.example",
      apiKey: "secret",
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        })
      ),
    });

    expect(result).toEqual({ exitCode: 1, body });
  });

  it("reserves stable scheduled-proof failure codes", () => {
    expect(TEMPORAL_HEALTH_CLI_REASON).toMatchObject({
      SCHEDULE_DRIFT: "schedule_drift",
      EXECUTION_STALE: "execution_stale",
      RECENT_TERMINAL_MISSING: "recent_terminal_missing",
    });
  });
});
