// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/health`
 * Purpose: Prove cheap readiness stays stable while deep readiness fails closed.
 * Scope: Local HTTP server with injected diagnostics; no Temporal connection.
 * @internal
 */

import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { type HealthState, startHealthServer } from "../src/health.js";

const servers: ReturnType<typeof startHealthServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve()))
      )
  );
});

async function serve(state: HealthState): Promise<string> {
  const server = startHealthServer(state, 0);
  servers.push(server);
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe("scheduler-worker health", () => {
  it("keeps cheap readiness independent of deep diagnostics", async () => {
    const baseUrl = await serve({ ready: true });
    expect(await (await fetch(`${baseUrl}/readyz`)).text()).toBe("ok");
    expect((await fetch(`${baseUrl}/readyz?deep=1`)).status).toBe(503);
  });

  it("returns server-observed poller evidence and worker identity", async () => {
    const baseUrl = await serve({
      ready: true,
      inspectTemporalPollers: async () => ({
        status: "healthy",
        reason: "ok",
        checkedAt: "2026-10-12T00:00:00.000Z",
        maxAgeMs: 120_000,
        checks: [
          {
            namespace: "cogni-candidate-a",
            taskQueue: "scheduler-tasks-node",
            taskType: "workflow",
            pollerCount: 1,
            freshestLastAccessAt: "2026-10-12T00:00:00.000Z",
            freshestAgeMs: 1,
            status: "fresh",
          },
        ],
      }),
    });

    const response = await fetch(`${baseUrl}/readyz?deep=1`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy",
      reason: "ok",
      worker: { service: "scheduler-worker" },
      checks: [{ status: "fresh", taskType: "workflow" }],
    });
  });

  it("returns 503 for stale or missing server pollers", async () => {
    const baseUrl = await serve({
      ready: true,
      inspectTemporalPollers: async () => ({
        status: "unhealthy",
        reason: "poller_missing",
        checkedAt: "2026-10-12T00:00:00.000Z",
        maxAgeMs: 120_000,
        checks: [],
      }),
    });
    expect((await fetch(`${baseUrl}/readyz?deep=1`)).status).toBe(503);
  });
});
