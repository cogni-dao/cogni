// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker-service/health`
 * Purpose: Health endpoint HTTP server for orchestrator probes.
 * Scope: /livez (liveness), /readyz (readiness), /version, /metrics endpoints.
 * Invariants:
 * - /livez always returns 200 (process alive)
 * - /readyz returns 200 only when ready=true, 503 otherwise
 * - /version returns build metadata (sha, service, buildTs, imageDigest)
 * - /metrics returns Prometheus exposition format
 * Side-effects: Binds HTTP server to HEALTH_PORT
 * Links: docs/spec/services-architecture.md, docs/spec/observability.md
 * @internal
 */

import { createServer, type Server } from "node:http";

import { metricsRegistry } from "./observability/index.js";
import type { TemporalPollerDiagnostic } from "./worker.js";

export interface HealthState {
  ready: boolean;
  inspectTemporalPollers?: () => Promise<TemporalPollerDiagnostic>;
}

/** Build metadata from env vars (set at build time or runtime) */
const versionInfo = {
  sha: process.env.GIT_SHA ?? "unknown",
  service: "scheduler-worker",
  buildTs: process.env.BUILD_TS ?? "unknown",
  imageDigest: process.env.IMAGE_DIGEST ?? "unknown",
};

export function startHealthServer(state: HealthState, port: number): Server {
  const server = createServer(async (req, res) => {
    if (req.url === "/livez") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    } else if (req.url === "/readyz?deep=1") {
      if (!state.inspectTemporalPollers) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "unhealthy",
            reason: "diagnostic_not_ready",
            worker: versionInfo,
            checks: [],
          })
        );
        return;
      }
      const diagnostic = await state.inspectTemporalPollers();
      res.writeHead(diagnostic.status === "healthy" ? 200 : 503, {
        "Content-Type": "application/json",
      });
      res.end(JSON.stringify({ ...diagnostic, worker: versionInfo }));
    } else if (req.url === "/readyz") {
      if (state.ready) {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
      } else {
        res.writeHead(503, { "Content-Type": "text/plain" });
        res.end("not ready");
      }
    } else if (req.url === "/version") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(versionInfo));
    } else if (req.url === "/metrics") {
      try {
        const metrics = await metricsRegistry.metrics();
        res.writeHead(200, {
          "Content-Type": metricsRegistry.contentType,
        });
        res.end(metrics);
      } catch {
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("error collecting metrics");
      }
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
    }
  });

  server.listen(port);
  return server;
}
