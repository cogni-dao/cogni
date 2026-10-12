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
  defaultWorkerHealthUrl,
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
    expect(defaultWorkerHealthUrl("production")).toBe(
      "http://cogni.vm.cognidao.org:30900"
    );
    expect(defaultWorkerHealthUrl("candidate-a")).toBe(
      "http://cogni-candidate-a.vm.cognidao.org:30900"
    );
  });

  it("joins app identity with exact server-observed worker pollers", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith("/version")) {
        return new Response(
          JSON.stringify({ version: "unknown", buildSha: "a".repeat(40) }),
          { status: 200 }
        );
      }
      return new Response(
        JSON.stringify({
          status: "healthy",
          reason: "ok",
          checkedAt: "2026-10-12T00:00:00.000Z",
          worker: {
            service: "scheduler-worker",
            sha: "b".repeat(40),
            imageDigest: `sha256:${"c".repeat(64)}`,
          },
          checks: [
            {
              namespace: "cogni-candidate-a",
              taskQueue: "scheduler-tasks-node",
              taskType: "workflow",
              status: "fresh",
            },
            {
              namespace: "cogni-candidate-a",
              taskQueue: "scheduler-tasks-node",
              taskType: "activity",
              status: "fresh",
            },
          ],
        }),
        { status: 200 }
      );
    });

    const result = await readTemporalHealth({
      baseUrl: "https://poly-test.cognidao.org",
      workerBaseUrl: "http://cogni.vm.cognidao.org:30900",
      nodeId: "node",
      namespace: "cogni-candidate-a",
      taskQueue: "scheduler-tasks-node",
      fetchImpl,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      body: {
        status: "healthy",
        nodeId: "node",
        app: { buildSha: "a".repeat(40) },
        worker: { sha: "b".repeat(40) },
        pollers: {
          workflow: { status: "fresh" },
          activity: { status: "fresh" },
        },
      },
    });
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
