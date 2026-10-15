// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/readyz`
 * Purpose: HTTP readiness endpoint. The default (k8s probe) path answers only "can this pod serve HTTP?" using local configuration checks.
 * Scope: Validates env, runtime secrets, and EVM RPC configuration without network or database IO. `?deep=1` additionally proves EVM RPC, Temporal, scheduler-worker, Doltgres, and the system tenant for explicit deploy/audit gates.
 * Invariants: Always returns valid readyz schema; force-dynamic runtime. The default path performs zero remote IO and therefore cannot exceed the kubelet deadline because a dependency is slow or wedged. `?deep=1` hard-fails substrate failures (503), and every deep probe MUST be bounded by its own timeout.
 * Side-effects: HTTP response and structured logging; network/database IO only with `?deep=1`.
 * Notes: Used by Docker HEALTHCHECK, deployment validation, K8s readiness probes.
 *        HTTP status is primary truth: 200 = ready, 503 = not ready.
 *        Provisioning / smoke checks that must assert the substrate is up call `/readyz?deep=1`.
 *        Logs readiness failures for deployment debugging.
 * Links: `@contracts/meta.readyz.read.v1.contract`, src/shared/env/invariants.ts, src/app/(infra)/livez/route.ts
 * @public
 */

import { metaReadyzOperation } from "@cogni/node-contracts";
import { NextResponse } from "next/server";
import {
  getContainer,
  resolveLocalReliabilityControl,
} from "@/bootstrap/container";
import { verifySystemTenant } from "@/bootstrap/healthchecks";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { EnvValidationError, serverEnv } from "@/shared/env";
import {
  assertEvmRpcConfig,
  assertKnowledgeStoreConnectivity,
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
  async (ctx, request): Promise<NextResponse> => {
    const proof = new URL(request.url).searchParams.get("proof");
    if (proof !== null) {
      if (proof !== "recovery" && proof !== "recovery-product") {
        return NextResponse.json(
          { status: "error", reason: "RECOVERY_PROOF_INVALID" },
          { status: 400 }
        );
      }
      try {
        const local = resolveLocalReliabilityControl();
        const env = serverEnv();
        if (!local.recoveryReader || !local.buildSha)
          throw new Error("recovery reader unavailable");
        const requestedSlug = new URL(request.url).searchParams.get(
          "node_slug"
        );
        if (
          requestedSlug !== null &&
          !/^[a-z][a-z0-9-]{0,62}$/.test(requestedSlug)
        ) {
          return NextResponse.json(
            { status: "error", reason: "RECOVERY_TARGET_INVALID" },
            { status: 400 }
          );
        }
        if (requestedSlug && requestedSlug !== local.slug) {
          if (!local.recoveryReader.readBoundTarget)
            throw new Error("bound recovery reader unavailable");
          const evidence = await local.recoveryReader.readBoundTarget({
            nodeSlug: requestedSlug,
            environment: env.DEPLOY_ENVIRONMENT as
              | "candidate-a"
              | "preview"
              | "production",
            proofClass: proof,
          });
          return NextResponse.json(evidence);
        }
        const evidence = await local.recoveryReader.read({
          nodeId: local.nodeId,
          nodeSlug: local.slug,
          environment: env.DEPLOY_ENVIRONMENT as
            | "candidate-a"
            | "preview"
            | "production",
          expectedBuildSha: local.buildSha,
          proofClass: proof,
        });
        return NextResponse.json(evidence);
      } catch (error) {
        logReadinessFailure(ctx, error as Error);
        return NextResponse.json(
          { status: "error", reason: "RECOVERY_PROOF_UNAVAILABLE" },
          { status: 503 }
        );
      }
    }
    // The kubelet path is deliberately local-only. `?deep=1` is the explicit
    // deploy/audit gate for remote substrate health.
    const deep = new URL(request.url).searchParams.get("deep") === "1";
    try {
      const env = serverEnv();

      // Set build info for metrics (canonical source: APP_BUILD_SHA from serverEnv())
      setBuildInfo(
        process.env.npm_package_version || "unknown",
        env.APP_BUILD_SHA || "unknown"
      );

      // Local serving contract: parse config and required secrets only. Never
      // construct the container or touch a network/database on this path.
      assertRuntimeSecrets(env);
      assertEvmRpcConfig(env);

      if (deep) {
        const container = getContainer();
        const evmRpcResult = await checkEvmRpcConnectivity(
          container.evmOnchainClient,
          env,
          { forceLive: true }
        );
        if (!evmRpcResult.ok) {
          const message = `EVM RPC connectivity check failed: ${evmRpcResult.errorMessage ?? "unknown"}`;
          ctx.log.error(
            {
              event: "substrate.evm_rpc.unreachable",
              severity: "critical",
              reason: "INFRA_UNREACHABLE",
              dependency: "evm-rpc",
              source: evmRpcResult.source,
              message,
            },
            "deep readiness: EVM RPC unreachable"
          );
          throw new InfraConnectivityError(message);
        }
        ctx.log.info(
          {
            event: "substrate.evm_rpc.reachable",
            dependency: "evm-rpc",
            source: evmRpcResult.source,
          },
          "deep readiness: EVM RPC reachable"
        );

        await assertTemporalConnectivity(container.scheduleControl, env);
        await assertSchedulerWorkerConnectivity(env);
        await assertKnowledgeStoreConnectivity(container.knowledgeStorePort);
        await verifySystemTenant(container.serviceAccountService);
      }

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
