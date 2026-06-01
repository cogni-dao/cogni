// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/readyz`
 * Purpose: HTTP endpoint providing readiness check with full validation (env, secrets, EVM RPC, Temporal).
 * Scope: Returns service readiness status; validates env, runtime secrets, EVM RPC connectivity, Temporal connectivity, and system tenant presence. Does not check DB connectivity beyond system tenant lookup.
 * Invariants: Always returns valid readyz schema; force-dynamic runtime; returns 503 only on env/secrets/Temporal/scheduler/tenant failure. EVM RPC is checked with TTL caching and treated as non-fatal (logged warning, still 200) so an upstream RPC blip can't drain the pod.
 * Side-effects: IO (HTTP response, structured logging, network calls to RPC and Temporal)
 * Notes: Used by Docker HEALTHCHECK, deployment validation, K8s readiness probes.
 *        HTTP status is primary truth: 200 = ready, 503 = not ready.
 *        Logs readiness failures for deployment debugging.
 * Links: `@contracts/meta.readyz.read.v1.contract`, src/shared/env/invariants.ts, src/app/(infra)/livez/route.ts
 * @public
 */

import { metaReadyzOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import { getContainer } from "@/bootstrap/container";
import { verifySystemTenant } from "@/bootstrap/healthchecks";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EnvValidationError, serverEnv } from "@/shared/env";
import {
  assertEvmRpcConfig,
  assertRuntimeSecrets,
  assertSchedulerWorkerConnectivity,
  assertTemporalConnectivity,
  checkEvmRpcConnectivity,
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";
import type { RequestContext } from "@/shared/observability";
import { setBuildInfo } from "@/shared/observability/server/metrics";

export const dynamic = "force-dynamic";

/**
 * Logs readiness check failure with structured context.
 * Called before returning 503 to ensure failures are visible in deployment logs.
 */
function logReadinessFailure(
  ctx: RequestContext,
  error:
    | EnvValidationError
    | RuntimeSecretError
    | InfraConnectivityError
    | Error
): void {
  if (error instanceof EnvValidationError) {
    ctx.log.error(
      {
        reason: error.meta.code,
        missing: error.meta.missing,
        invalid: error.meta.invalid,
      },
      "readiness check failed: invalid environment configuration"
    );
  } else if (error instanceof RuntimeSecretError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: missing runtime secret"
    );
  } else if (error instanceof InfraConnectivityError) {
    ctx.log.error(
      {
        reason: error.code,
        message: error.message,
      },
      "readiness check failed: infrastructure unreachable"
    );
  } else {
    ctx.log.error(
      {
        reason: "INTERNAL_ERROR",
        error: error.message,
      },
      "readiness check failed: internal error"
    );
  }
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "meta.readyz", auth: { mode: "none" } },
  async (ctx): Promise<NextResponse> => {
    try {
      const env = serverEnv();
      const container = getContainer();

      // Set build info for metrics (canonical source: APP_BUILD_SHA from serverEnv())
      setBuildInfo(
        process.env.npm_package_version || "unknown",
        env.APP_BUILD_SHA || "unknown"
      );

      // MVP readiness: Validate env + runtime secrets + EVM RPC + Temporal connectivity
      assertRuntimeSecrets(env);

      // EVM RPC: required-config is fatal (missing URL = misconfig), but live
      // connectivity is non-fatal. K8s probes /readyz every 5s on every pod;
      // failing the pod when an upstream RPC 429s or blips would drain the
      // fleet for a transient issue that doesn't affect chat/AI traffic.
      // Payment processing has its own retry/verification path.
      if (container.paymentRailsActive) {
        assertEvmRpcConfig(env);
        const evmRpcResult = await checkEvmRpcConnectivity(
          container.evmOnchainClient,
          env
        );
        if (!evmRpcResult.ok) {
          ctx.log.warn(
            {
              reason: "EVM_RPC_DEGRADED",
              source: evmRpcResult.source,
              error: evmRpcResult.errorMessage,
            },
            "readiness: EVM RPC unreachable, returning ready (non-fatal)"
          );
        }
      }

      // Test Temporal connectivity (5s budget, triggers lazy connection)
      // This catches Temporal not running before stack tests execute
      await assertTemporalConnectivity(container.scheduleControl, env);

      // Test scheduler-worker connectivity (5s budget)
      // This ensures the Temporal worker is polling before stack tests run
      await assertSchedulerWorkerConnectivity(env);

      // Verify system tenant billing account exists (per SYSTEM_TENANT_STARTUP_CHECK)
      await verifySystemTenant(container.serviceAccountService);

      const payload = {
        status: "healthy" as const,
        timestamp: new Date().toISOString(),
        version: process.env.npm_package_version || undefined,
        buildSha: env.APP_BUILD_SHA || undefined,
      };

      const parsed = metaReadyzOperation.output.parse(payload);
      return NextResponse.json(parsed);
    } catch (error) {
      // HTTP status is primary truth for K8s: 503 = not ready
      // Log failure before returning 503 for deployment debugging
      if (error instanceof EnvValidationError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.meta.code,
            details: error.meta,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Runtime secret validation failures (typed error from assertRuntimeSecrets)
      if (error instanceof RuntimeSecretError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.code,
            message: error.message,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Infrastructure connectivity failures (Temporal, etc.)
      if (error instanceof InfraConnectivityError) {
        logReadinessFailure(ctx, error);
        return new NextResponse(
          JSON.stringify({
            status: "error",
            reason: error.code,
            message: error.message,
          }),
          {
            status: 503, // Service Unavailable - not ready
            headers: { "content-type": "application/json" },
          }
        );
      }

      // Unknown error - log and return generic 503
      logReadinessFailure(ctx, error as Error);
      return new NextResponse(
        JSON.stringify({
          status: "error",
          reason: "INTERNAL_ERROR",
        }),
        {
          status: 503, // Service Unavailable - not ready
          headers: { "content-type": "application/json" },
        }
      );
    }
  }
);
