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
  const appSha = "a".repeat(40);
  const workerSha = "b".repeat(40);
  const workerDigest = `sha256:${"c".repeat(64)}`;
  const healthyBody = {
    status: "healthy",
    reason: "ok",
    mode: "compatibility",
    nodeId: "node-123",
    namespace: "cogni-candidate-a",
    taskQueue: "scheduler-tasks-node-123",
    app: { buildSha: appSha },
    worker: { sha: workerSha, imageDigest: workerDigest },
    pollers: {
      workflow: { status: "fresh" },
      activity: { status: "fresh" },
    },
    schedules: {
      status: "healthy",
      reason: "ok",
      declaredCount: 1,
      observedCount: 1,
      reconciledCount: 1,
      driftCount: 0,
      dueCount: 1,
      terminalCount: 1,
    },
  };

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
      new Response(JSON.stringify(healthyBody), {
        status: 200,
      })
    );

    const result = await readTemporalHealth({
      baseUrl: "https://test.cognidao.org",
      apiKey: "secret",
      expectedAppSha: appSha,
      expectedWorkerSha: workerSha,
      expectedWorkerDigest: workerDigest,
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

  it("reserves stable exact-artifact drift codes", () => {
    expect(TEMPORAL_HEALTH_CLI_REASON).toMatchObject({
      APP_IDENTITY_DRIFT: "app_identity_drift",
      WORKER_IDENTITY_DRIFT: "worker_identity_drift",
    });
  });

  it("rejects a false-green payload without schedule and execution proof", async () => {
    const result = await readTemporalHealth({
      baseUrl: "https://node.example",
      apiKey: "secret",
      expectedAppSha: appSha,
      expectedWorkerSha: workerSha,
      expectedWorkerDigest: workerDigest,
      fetchImpl: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            status: "healthy",
            reason: "ok",
            app: healthyBody.app,
            worker: healthyBody.worker,
          }),
          { status: 200 }
        )
      ),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      body: { reason: "response_malformed" },
    });
  });

  it("fails closed when the deployed app SHA differs", async () => {
    const result = await readTemporalHealth({
      baseUrl: "https://node.example",
      apiKey: "secret",
      expectedAppSha: "d".repeat(40),
      expectedWorkerSha: workerSha,
      expectedWorkerDigest: workerDigest,
      fetchImpl: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify(healthyBody), { status: 200 })
        ),
    });

    expect(result).toMatchObject({
      exitCode: 1,
      body: { reason: "app_identity_drift" },
    });
  });
});
