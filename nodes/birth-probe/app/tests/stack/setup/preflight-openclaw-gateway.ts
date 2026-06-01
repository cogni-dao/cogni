// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/setup/preflight-openclaw-gateway`
 * Purpose: Vitest globalSetup that waits for the OpenClaw gateway Docker healthcheck to pass before stack tests run.
 * Scope: Polls Docker health status + TCP port 3333 with a budget; skips gracefully if gateway container not present.
 * Invariants: Must run after wait-for-probes (app is up) but before functional tests.
 * Side-effects: IO (Docker API inspect, TCP connect to localhost:3333)
 * Links: infra/compose/runtime/docker-compose.dev.yml (openclaw-gateway service)
 * @internal
 */

import { execSync } from "node:child_process";
import { connect } from "node:net";
import Docker from "dockerode";

const GATEWAY_CONTAINER = "openclaw-gateway";
const PROXY_CONTAINER = "llm-proxy-openclaw";
const GATEWAY_HOST = "127.0.0.1";
const GATEWAY_PORT = 3333;
const BUDGET_MS = 120_000; // 120s — gateway has 20s start_period + CI cold-start variance
const INTERVAL_MS = 3_000;
const CONNECT_TIMEOUT_MS = 2_000;

function tryTcpConnect(
  host: string,
  port: number,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(false);
    }, timeoutMs);
    sock.on("connect", () => {
      clearTimeout(timer);
      sock.end();
      resolve(true);
    });
    sock.on("error", () => {
      clearTimeout(timer);
      sock.destroy();
      resolve(false);
    });
  });
}

async function isDockerHealthy(
  docker: Docker,
  name: string
): Promise<"healthy" | "unhealthy" | "starting" | "not_found"> {
  try {
    const container = docker.getContainer(name);
    const info = await container.inspect();
    if (!info.State.Running) return "not_found";
    return (
      (info.State.Health?.Status as "healthy" | "unhealthy" | "starting") ??
      "starting"
    );
  } catch {
    return "not_found";
  }
}

function collectDiagnostics(): string {
  const lines: string[] = ["", "=== Diagnostics ==="];
  try {
    const ps = execSync(
      "docker ps -a --filter name=openclaw-gateway --filter name=llm-proxy-openclaw --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'",
      { timeout: 5_000, encoding: "utf-8" }
    );
    lines.push("--- docker ps ---", ps.trim());
  } catch {
    lines.push("(docker ps failed)");
  }
  for (const name of [GATEWAY_CONTAINER, PROXY_CONTAINER]) {
    try {
      const logs = execSync(`docker logs ${name} --tail 30 2>&1`, {
        timeout: 5_000,
        encoding: "utf-8",
      });
      lines.push(`--- ${name} logs (last 30) ---`, logs.trim());
    } catch {
      lines.push(`--- ${name} logs --- (not available)`);
    }
  }
  return lines.join("\n");
}

// biome-ignore lint/style/noDefaultExport: Vitest globalSetup requires default export
export default async function preflightOpenclawGateway() {
  const docker = new Docker();

  // If the gateway container doesn't exist at all, skip gracefully
  // (local dev without --profile sandbox-openclaw)
  const initialStatus = await isDockerHealthy(docker, GATEWAY_CONTAINER);
  if (initialStatus === "not_found") {
    console.log(
      `\n⏭️  OpenClaw gateway container not present — skipping preflight (run with --profile sandbox-openclaw to enable)\n`
    );
    return;
  }

  // Container exists — poll until Docker reports healthy AND TCP connects
  console.log(
    `\n🔍 Preflight: waiting for OpenClaw gateway (Docker health + TCP ${GATEWAY_HOST}:${GATEWAY_PORT}, ${BUDGET_MS / 1000}s budget)...`
  );

  const startTime = Date.now();
  const maxAttempts = Math.ceil(BUDGET_MS / INTERVAL_MS);

  for (let i = 1; i <= maxAttempts; i++) {
    const healthStatus = await isDockerHealthy(docker, GATEWAY_CONTAINER);
    const tcpOk =
      healthStatus === "healthy" &&
      (await tryTcpConnect(GATEWAY_HOST, GATEWAY_PORT, CONNECT_TIMEOUT_MS));

    if (tcpOk) {
      const elapsed = Date.now() - startTime;
      console.log(
        `✅ OpenClaw gateway ready (healthy + TCP ${GATEWAY_HOST}:${GATEWAY_PORT}) in ${elapsed}ms\n`
      );
      return;
    }

    if (healthStatus === "unhealthy") {
      // Container failed its healthcheck — don't wait, fail fast with diagnostics
      const diag = collectDiagnostics();
      throw new Error(
        `❌ OpenClaw gateway container is unhealthy (Docker healthcheck failed).\n${diag}`
      );
    }

    if (i < maxAttempts) {
      console.log(
        `⏳ Gateway preflight attempt ${i}/${maxAttempts}: ${healthStatus}, retrying...`
      );
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  }

  const elapsed = Date.now() - startTime;
  const diag = collectDiagnostics();
  throw new Error(
    [
      `❌ OpenClaw gateway not ready after ${elapsed}ms (${maxAttempts} attempts).`,
      `   Expected Docker healthy + TCP on ${GATEWAY_HOST}:${GATEWAY_PORT}`,
      diag,
      "",
      "To start the gateway:",
      "  pnpm sandbox:openclaw:up",
    ].join("\n")
  );
}
