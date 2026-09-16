// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/readyz`
 * Purpose: HTTP readiness endpoint. The default (k8s probe) path answers only "can this pod serve HTTP?" — local serving readiness: env, runtime secrets, system tenant.
 * Scope: Validates env + runtime secrets + system tenant (fatal). Checks EVM RPC, Temporal, and scheduler-worker connectivity but treats transient failures as NON-FATAL on the default probe (logged, still 200). `?deep=1` restores hard substrate assertion for provisioning / stack-test smoke checks.
 * Invariants: Always returns valid readyz schema; force-dynamic runtime. Every managed non-test node requires and exercises EVM RPC even before payment activation. The default path does not drain the fleet for a transient upstream failure (incident 2026-06-26: scheduler-worker hiccup → fleet-wide 502); `?deep=1` forces a live RPC read and makes EVM RPC, Temporal, and scheduler-worker failures fatal (503).
 * Side-effects: IO (HTTP response, structured logging, network calls to RPC and Temporal)
 * Notes: Used by Docker HEALTHCHECK, deployment validation, K8s readiness probes.
 *        HTTP status is primary truth: 200 = ready, 503 = not ready.
 *        Provisioning / smoke checks that must assert the substrate is up call `/readyz?deep=1`.
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

/**
 * Async-substrate connectivity check that is NON-FATAL to the k8s readiness
 * probe by default. Temporal and scheduler-worker are async dispatch substrate,
 * not synchronous serving dependencies — failing /readyz on their blip drains
 * every node-app from its Service endpoints and causes a fleet-wide 502
 * (incident 2026-06-26). Same rationale already applied to EVM RPC.
 *
 * They ARE mission-critical: all AI/chat work is dispatched through Temporal, so
 * a sustained outage means AI is down. We therefore log failures at ERROR with a
 * stable `event` + `severity:"critical"` so monitoring fires a critical alert,
 * and the request paths that need the substrate return 503 at request time — we
 * just never take the public site down with the probe.
 *
 * `deep` (from `?deep=1`) restores hard-fail semantics for provisioning /
 * stack-test smoke checks that must assert the substrate is actually up.
 */
async function assertSubstrate(
  check: () => Promise<void>,
  opts: {
    ctx: RequestContext;
    deep: boolean;
    event: string;
    dependency: string;
  }
): Promise<void> {
  try {
    await check();
  } catch (error) {
    if (opts.deep) throw error; // explicit deep probe: hard-fail (503)
    if (error instanceof InfraConnectivityError) {
      opts.ctx.log.error(
        {
          event: opts.event,
          severity: "critical",
          reason: error.code,
          dependency: opts.dependency,
          message: error.message,
        },
        `readiness: ${opts.dependency} unreachable — MISSION-CRITICAL async substrate down (AI/chat is dispatched through Temporal). Returning ready: probe stays non-fatal so the fleet is not drained; the critical alert + request-time 503 cover it.`
      );
      return;
    }
    throw error; // unexpected error type → fall through to default 503 handling
  }
}

export const GET = wrapRouteHandlerWithLogging(
  { routeId: "meta.readyz", auth: { mode: "none" } },
  async (ctx, request): Promise<NextResponse> => {
    // `?deep=1` restores hard-fail substrate semantics for provisioning /
    // stack-test smoke checks; the default (k8s probe) path is non-fatal.
    const deep = new URL(request.url).searchParams.get("deep") === "1";
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

      // EVM RPC is baseline node substrate, not conditional payment state.
      // Missing config is a deployment error. Transient connectivity remains
      // non-fatal for the default K8s probe so an upstream 429/blip cannot drain
      // the fleet; explicit deep readiness forces a fresh Base RPC read and
      // fails closed for birth/promotion proof.
      assertEvmRpcConfig(env);
      const evmRpcResult = await checkEvmRpcConnectivity(
        container.evmOnchainClient,
        env,
        { forceLive: deep }
      );
      if (!evmRpcResult.ok) {
        const message = `EVM RPC connectivity check failed: ${evmRpcResult.errorMessage ?? "unknown"}`;
        const context = {
          event: "substrate.evm_rpc.unreachable",
          severity: deep ? "critical" : "degraded",
          reason: "INFRA_UNREACHABLE",
          dependency: "evm-rpc",
          source: evmRpcResult.source,
          message,
        };
        if (deep) {
          ctx.log.error(context, "deep readiness: EVM RPC unreachable");
          throw new InfraConnectivityError(message);
        }
        ctx.log.warn(
          context,
          "readiness: EVM RPC unreachable, returning ready (non-fatal)"
        );
      } else if (deep) {
        ctx.log.info(
          {
            event: "substrate.evm_rpc.reachable",
            dependency: "evm-rpc",
            source: evmRpcResult.source,
          },
          "deep readiness: EVM RPC reachable"
        );
      }

      // Async substrate: Temporal + scheduler-worker. NON-FATAL to the k8s
      // probe by default (a blip must not drain the fleet → 502), but
      // mission-critical: failures are logged at ERROR with a critical-severity
      // event so monitoring alarms. `?deep=1` hard-fails (503) for provisioning
      // / stack-test smoke checks that must confirm the substrate is up.
      await assertSubstrate(
        () => assertTemporalConnectivity(container.scheduleControl, env),
        {
          ctx,
          deep,
          event: "substrate.temporal.unreachable",
          dependency: "temporal",
        }
      );
      await assertSubstrate(() => assertSchedulerWorkerConnectivity(env), {
        ctx,
        deep,
        event: "substrate.scheduler_worker.unreachable",
        dependency: "scheduler-worker",
      });

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
