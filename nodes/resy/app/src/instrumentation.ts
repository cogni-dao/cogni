// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@instrumentation`
 * Purpose: Next.js instrumentation hook — once-per-process startup orchestration.
 * Scope: Initialize OTel SDK and run preflight checks. Does NOT export SDK instance or run during build.
 * Invariants:
 *   - OTel init happens ONLY in this file (not container module-load)
 *   - Must await sdk.start() and hard-fail in non-dev if startup fails
 *   - Service name via OTEL_SERVICE_NAME env var (not constructor option)
 *   - No auto-instrumentation for P0 (explicit spans only)
 *   - P0 has NO OTel exporter (IDs + Langfuse only; no Tempo/Grafana traces yet)
 * Side-effects: IO (OTel SDK global state initialization)
 * Notes: Next.js calls register() once per Node.js process on startup.
 * Links: AI_SETUP_SPEC.md, bootstrap/otel.ts for span helpers
 * @public
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import pino from "pino";
import {
  resolveBootSyncConfig,
  runGovernanceBootSync,
} from "@/lib/governance-boot-sync";

let sdk: NodeSDK | null = null;

/**
 * Emit one structured startup log with the image build SHA so grafana-based
 * agents can correlate a running pod to its PR/commit. Self-contained pino
 * instance because the shared logger sits behind the bootstrap/container
 * wiring, which dep-cruiser forbids instrumentation.ts from importing.
 */
function logAppStarted(): void {
  // biome-ignore lint/style/noProcessEnv: startup log emitted before config framework
  if (process.env.APP_ENV === "test" || process.env.VITEST === "true") {
    return;
  }
  const bootLogger = pino({
    base: {
      app: "cogni-template",
      // biome-ignore lint/style/noProcessEnv: startup log before config framework
      service: process.env.SERVICE_NAME ?? "app",
    },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
  });
  // biome-ignore lint/style/noProcessEnv: build-time plumbing injected via Dockerfile ARG
  const buildSha = process.env.APP_BUILD_SHA;
  if (buildSha) {
    bootLogger.info({ buildSha }, "app started");
  } else {
    // No fallback string — emit at warn so missing/forgotten BUILD_SHA is visible
    // rather than cloaked behind a placeholder.
    bootLogger.warn(
      { buildSha: null },
      "app started (APP_BUILD_SHA unset — check CI --build-arg BUILD_SHA)"
    );
  }
}

/**
 * Initialize OTel SDK with P0 configuration.
 * Shared between Next.js instrumentation and test setup.
 *
 * Per AI_SETUP_SPEC.md:
 * - Service name via OTEL_SERVICE_NAME env var (SDK reads it automatically)
 * - No auto-instrumentation for P0 (explicit spans only)
 * - No exporter for P0 (IDs + Langfuse only; no Tempo/Grafana traces yet)
 *
 * @param options - Optional configuration
 * @param options.failOnError - Whether to throw on startup failure (default: !isDev)
 * @returns true if SDK started successfully, false otherwise
 */
export async function initOtelSdk(options?: {
  failOnError?: boolean;
}): Promise<boolean> {
  // Skip if already initialized
  if (sdk !== null) {
    return true;
  }

  // P0: No exporter configured - we only need trace IDs for correlation
  // Future P2: Add OTLP exporter for Tempo/Grafana
  sdk = new NodeSDK({
    // Service name read from OTEL_SERVICE_NAME env var (SDK default behavior)
    // No instrumentations for P0 (explicit spans only via withRootSpan)
    instrumentations: [],
  });

  try {
    await sdk.start();

    // Log successful initialization (console since Pino may not be ready)
    // Suppress in any test mode to avoid spamming per-fork output
    // biome-ignore lint/style/noProcessEnv: APP_ENV/VITEST check for test silence
    if (process.env.APP_ENV !== "test" && process.env.VITEST !== "true") {
      // biome-ignore lint/suspicious/noConsole: OTel init happens before logging is available
      console.log("[instrumentation] OTel SDK started successfully");
    }
    return true;
  } catch (error) {
    // biome-ignore lint/style/noProcessEnv: NODE_ENV is standard Next.js runtime env
    const isDev = process.env.NODE_ENV === "development";
    const shouldFail = options?.failOnError ?? !isDev;

    // biome-ignore lint/suspicious/noConsole: OTel init happens before logging is available
    console.error("[instrumentation] OTel SDK startup failed:", error);

    if (shouldFail) {
      // Hard-fail when required (per AI_SETUP_SPEC.md)
      throw error;
    }
    // Graceful degradation
    return false;
  }
}

/**
 * Next.js instrumentation hook - called once per Node.js process.
 * Orchestrates OTel init + preflight checks.
 */
export async function register(): Promise<void> {
  // Only initialize in Node.js runtime (allowlist, not denylist)
  // biome-ignore lint/style/noProcessEnv: NEXT_RUNTIME is set by Next.js, no config file
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  await initOtelSdk();
  logAppStarted();

  // Self-register governance + ledger(epoch) Temporal schedules at boot, so a node (incl. a
  // forked node-template) goes live without an operator/deploy-pipeline step. Replaces the
  // removed `scripts/ci/deploy.sh` Step 10.1. Fire-and-forget + fail-soft; the helper retries
  // while the HTTP server binds. Skipped in test.
  // biome-ignore lint/style/noProcessEnv: startup check before the config framework
  const bootEnv = process.env;
  if (bootEnv.APP_ENV !== "test") {
    void runGovernanceBootSync(resolveBootSyncConfig(bootEnv)).catch(() => {});
  }

  // Dev mode (not test): warn if LiteLLM has stale test config from a previous session.
  // Inlined here (not in bootstrap/) because dep-cruiser forbids instrumentation→bootstrap imports.
  // biome-ignore lint/style/noProcessEnv: startup check before config framework
  if (process.env.APP_ENV !== "test") {
    (async () => {
      // biome-ignore lint/style/noProcessEnv: startup check before config framework
      const baseUrl = process.env.LITELLM_BASE_URL;
      // biome-ignore lint/style/noProcessEnv: startup check before config framework
      const masterKey = process.env.LITELLM_MASTER_KEY;
      if (!baseUrl || !masterKey) return;
      try {
        const res = await fetch(`${baseUrl}/v1/models`, {
          headers: { Authorization: `Bearer ${masterKey}` },
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { data?: Array<{ id: string }> };
        const ids = (data.data ?? []).map((m) => m.id);
        if (ids.includes("test-model")) {
          // biome-ignore lint/suspicious/noConsole: startup warning before logging
          console.warn(
            [
              "",
              "  ╔══════════════════════════════════════════════════════════════╗",
              "  ║  WARNING: LiteLLM is loaded with TEST config (test-model)  ║",
              "  ║  dev:stack expects prod config (litellm.config.yaml).      ║",
              "  ║                                                            ║",
              "  ║  LLM calls will route to mock-openai-api, not real LLMs.  ║",
              "  ║                                                            ║",
              "  ║  Fix: docker compose down litellm && pnpm dev:stack        ║",
              "  ╚══════════════════════════════════════════════════════════════╝",
              "",
            ].join("\n")
          );
        }
      } catch {
        // Non-fatal: LiteLLM might not be up yet
      }
    })().catch(() => {});
  }
}

/**
 * Get the initialized SDK instance.
 * Returns null if SDK not initialized (Edge runtime or initialization failed).
 * @internal - Use withRootSpan() from bootstrap/otel.ts instead
 */
export function getOtelSdk(): NodeSDK | null {
  return sdk;
}
