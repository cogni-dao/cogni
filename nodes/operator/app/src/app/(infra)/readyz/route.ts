// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Operator readiness and recovery proof; recovery executes before container access. */
import { metaReadyzOperation } from "@cogni/node-contracts";
import { serveReadyz } from "@cogni/substrate-health";
import { NextResponse } from "next/server";
import {
  getContainer,
  resolveLocalReliabilityControl,
} from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { getNodeId } from "@/shared/config";
import { EnvValidationError, serverEnv } from "@/shared/env";
import {
  assertEvmRpcConfig,
  assertRuntimeSecrets,
  InfraConnectivityError,
  RuntimeSecretError,
} from "@/shared/env/invariants";
import {
  createRequestContext,
  httpRequestDurationMs,
  httpRequestsTotal,
  logRequestEnd,
  makeLogger,
  type RequestContext,
  statusBucket,
} from "@/shared/observability";
import { setBuildInfo } from "@/shared/observability/server/metrics";
import { buildDeepChecks, deepRuntime } from "./readyz-probes";

export const dynamic = "force-dynamic";
function logReadinessFailure(ctx: RequestContext, error: unknown): void {
  const reason =
    error instanceof EnvValidationError
      ? "INVALID_ENV"
      : error instanceof RuntimeSecretError
        ? "MISSING_RUNTIME_SECRET"
        : error instanceof InfraConnectivityError
          ? "INFRA_UNREACHABLE"
          : "INTERNAL_ERROR";
  try {
    ctx.log.error({ errorCode: reason }, "readiness check failed");
  } catch {}
}

export async function GET(request: Request): Promise<NextResponse> {
  let started = 0;
  let status = 500;
  let errorCode: string | undefined;
  let settledResponse: NextResponse | undefined;
  let log: ReturnType<typeof makeLogger> | undefined;
  try {
    started = performance.now();
    return await withRootSpan(
      "GET meta.readyz",
      { route_id: "meta.readyz" },
      async ({ traceId, span }) => {
        try {
          log = makeLogger({
            service: "cogni-template",
            route: "meta.readyz",
            method: request.method,
            traceId,
          });
          let nodeId: string | undefined;
          try {
            nodeId = getNodeId();
          } catch (error) {
            if (
              !(
                error instanceof EnvValidationError ||
                error instanceof RuntimeSecretError
              )
            )
              throw error;
          }
          if (nodeId)
            log = makeLogger({
              service: "cogni-template",
              route: "meta.readyz",
              method: request.method,
              traceId,
              nodeId,
            });
          const ctx = createRequestContext(
            { baseLog: log, clock: { now: () => new Date().toISOString() } },
            request,
            { routeId: "meta.readyz", traceId }
          );
          log = ctx.log;
          span.setAttribute("request_id", ctx.reqId);
          const handle = async (): Promise<NextResponse> => {
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
            const result = await serveReadyz({
              deep: new URL(request.url).searchParams.get("deep") === "1",
              local: () => {
                const env = serverEnv();
                assertRuntimeSecrets(env);
                assertEvmRpcConfig(env);
                try {
                  setBuildInfo(
                    process.env.npm_package_version || "unknown",
                    env.APP_BUILD_SHA || "unknown"
                  );
                } catch {}
                return {
                  buildSha: env.APP_BUILD_SHA || undefined,
                  version: process.env.npm_package_version || undefined,
                };
              },
              deepChecks: () =>
                buildDeepChecks(ctx, getContainer(), serverEnv()),
              runtime: {
                ...deepRuntime(ctx),
                log: (
                  ...args: Parameters<ReturnType<typeof deepRuntime>["log"]>
                ) => {
                  try {
                    deepRuntime(ctx).log(...args);
                  } catch {}
                },
              },
              onFailure: (error) => {
                try {
                  errorCode =
                    error instanceof EnvValidationError
                      ? "INVALID_ENV"
                      : error instanceof RuntimeSecretError
                        ? "MISSING_RUNTIME_SECRET"
                        : error instanceof InfraConnectivityError
                          ? "INFRA_UNREACHABLE"
                          : "INTERNAL_ERROR";
                } catch {
                  errorCode = "INTERNAL_ERROR";
                }
              },
              describeError: (error) => {
                if (error instanceof EnvValidationError)
                  return { reason: error.meta.code, details: error.meta };
                if (
                  error instanceof RuntimeSecretError ||
                  error instanceof InfraConnectivityError
                )
                  return { reason: error.code, message: error.message };
                return { reason: "INTERNAL_ERROR" };
              },
            });
            const output =
              result.status === 200
                ? metaReadyzOperation.output.parse(result.body)
                : result.body;
            return NextResponse.json(output, { status: result.status });
          };
          const response = await handle();
          status = response.status;
          settledResponse = response;
          return response;
        } catch {
          errorCode = "INTERNAL_SERVER_ERROR";
          status = 500;
          settledResponse = new NextResponse(
            JSON.stringify({ status: "error", reason: "INTERNAL_ERROR" }),
            { status: 500, headers: { "content-type": "application/json" } }
          );
          return settledResponse;
        }
      }
    );
  } catch {
    if (settledResponse) return settledResponse;
    status = 500;
    errorCode = "INTERNAL_SERVER_ERROR";
    return new NextResponse(
      JSON.stringify({ status: "error", reason: "INTERNAL_ERROR" }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  } finally {
    try {
      if (errorCode)
        log?.error(
          { errorCode },
          errorCode === "INTERNAL_SERVER_ERROR"
            ? "request failed"
            : "readiness check failed"
        );
    } catch {}
    let durationMs = 0;
    try {
      durationMs = performance.now() - started;
    } catch {}
    try {
      if (log) logRequestEnd(log, { status, durationMs });
    } catch {}
    try {
      httpRequestsTotal.inc({
        route: "meta.readyz",
        method: request.method,
        status: statusBucket(status),
      });
    } catch {}
    try {
      httpRequestDurationMs.observe(
        { route: "meta.readyz", method: request.method },
        durationMs
      );
    } catch {}
  }
}
