// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/internal/graphs/[graphId]/runs`
 * Purpose: Internal API endpoint for graph execution (scheduled and API-triggered).
 * Scope: Auth-protected POST endpoint called by scheduler-worker (via Temporal activity). Handles both grant-backed scheduled runs and API-triggered runs with billing context in payload. Does not contain graph execution logic.
 * Invariants:
 *   - INTERNAL_API_SHARED_SECRET: Requires Bearer SCHEDULER_API_TOKEN
 *   - EXECUTION_IDEMPOTENCY_PERSISTED: Uses execution_requests table for deduplication
 *   - GRANT_VALIDATED_TWICE: Re-validates grant (defense-in-depth)
 *   - Per CREDITS_ENFORCED_AT_EXECUTION_PORT: preflight credit check via decorator (DI closure)
 *   - Uses AiExecutionErrorCode from ai-core (no parallel error system)
 *   - Per PUMP_TO_COMPLETION_VIA_REDIS: publishes AiEvents to Redis Stream as it drains the executor stream
 *   - Per STREAM_PUBLISH_IN_EXECUTION_LAYER: Redis publishing happens here, not in Temporal activity
 *   - Per PERSIST_AFTER_PUMP: persists assistant message to thread after full stream drain (disconnect-safe)
 *   - Per IDEMPOTENT_THREAD_PERSIST: assistant message ID = `assistant-{runId}` — skips if already persisted
 *   - Scheduled run stateKey = sha256(idempotencyKey) — one isolated thread per execution slot, not per schedule
 * Side-effects: IO (HTTP request/response, database, graph execution, Redis stream publishing, thread persistence)
 * Links: docs/spec/scheduler.md, graphs.run.internal.v1.contract
 * @internal
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { AiEvent } from "@cogni/ai-core";
import { RUN_STREAM_DEFAULT_TTL_SECONDS } from "@cogni/graph-execution-core";
import { toUserId } from "@cogni/ids";
import { SYSTEM_ACTOR } from "@cogni/ids/system";
import {
  InternalGraphRunInputSchema,
  type InternalGraphRunOutput,
} from "@cogni/node-contracts";
import { AnalyticsEvents, capture } from "@cogni/node-shared";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getContainer } from "@/bootstrap/container";
import {
  createGraphExecutor,
  createScopedGraphExecutor,
} from "@/bootstrap/graph-executor.factory";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  assembleAssistantMessage,
  executeStream,
  redactSecretsInMessages,
} from "@/features/ai/public.server";
import { commitUsageFact } from "@/features/ai/services/billing";
import { preflightCreditCheck } from "@/features/ai/services/preflight-credit-check";
import type { PreflightCreditCheckFn } from "@/ports";
import { isInsufficientCreditsPortError, ThreadConflictError } from "@/ports";
import {
  isGrantExpiredError,
  isGrantNotFoundError,
  isGrantRevokedError,
  isGrantScopeMismatchError,
} from "@/ports/server";
import { serverEnv } from "@/shared/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Max auth header length to prevent DoS */
const MAX_AUTH_HEADER_LENGTH = 512;
/** Max token length after parsing (before hashing) */
const MAX_TOKEN_LENGTH = 256;

/**
 * Constant-time string comparison.
 * Both values are server-generated API tokens (not user passwords),
 * so we compare buffers directly — no key-stretching needed.
 */
function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Extract bearer token from Authorization header.
 */
function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.length > MAX_AUTH_HEADER_LENGTH) return null;

  const trimmed = authHeader.trim();
  const lowerPrefix = trimmed.toLowerCase();

  if (!lowerPrefix.startsWith("bearer ")) return null;

  const token = trimmed.slice(7).trim();
  if (token.length > MAX_TOKEN_LENGTH) return null;

  return token;
}

/**
 * Compute SHA256 hash of normalized request payload for idempotency check.
 */
function computeRequestHash(graphId: string, input: unknown): string {
  const normalized = JSON.stringify({ graphId, input });
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

/**
 * Extract the stable schedule ID from an idempotency key.
 * Format: "{temporalScheduleId}:{ISO-8601 scheduledFor}"
 * Schedule IDs may contain colons (e.g. "governance:govern"), so we match
 * the ISO-8601 timestamp boundary (":YYYY-MM-DDT") rather than splitting naively.
 * @internal Exported for testing only.
 */
export function extractScheduleId(idempotencyKey: string): string {
  const isoSeparatorIdx = idempotencyKey.search(/:\d{4}-\d{2}-\d{2}T/);
  return isoSeparatorIdx > 0
    ? idempotencyKey.slice(0, isoSeparatorIdx)
    : idempotencyKey;
}

interface RouteParams {
  params: Promise<{ graphId: string }>;
}

/**
 * POST /api/internal/graphs/{graphId}/runs
 *
 * Internal endpoint for scheduled graph execution.
 * Called by scheduler-worker with Bearer SCHEDULER_API_TOKEN.
 *
 * Headers:
 * - Authorization: Bearer {SCHEDULER_API_TOKEN}
 * - Idempotency-Key: {scheduleId}:{scheduledFor}
 *
 * HTTP errors:
 * - 401: Missing/invalid SCHEDULER_API_TOKEN
 * - 403: Grant invalid/expired/revoked/scope mismatch
 * - 404: Graph not found (checked in catalog)
 * - 422: Idempotency conflict (hash mismatch)
 */
export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "graphs.run.internal", auth: { mode: "none" } },
  async (ctx, request, _sessionUser, routeParams) => {
    const env = serverEnv();
    const container = getContainer();
    const log = ctx.log;

    // --- 1. Bearer token auth ---
    const configuredToken = env.SCHEDULER_API_TOKEN;
    if (!configuredToken) {
      log.error("SCHEDULER_API_TOKEN not configured");
      return NextResponse.json(
        { error: "Service not configured" },
        { status: 500 }
      );
    }

    const authHeader = request.headers.get("authorization");
    const providedToken = extractBearerToken(authHeader);

    if (!providedToken || !safeCompare(providedToken, configuredToken)) {
      log.warn("Invalid or missing SCHEDULER_API_TOKEN");
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // --- 2. Extract graphId from path ---
    if (!routeParams) {
      log.error("Route params missing");
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const params = await routeParams.params;
    const rawGraphId = params.graphId;
    if (!rawGraphId || !rawGraphId.includes(":")) {
      log.warn(
        { graphId: rawGraphId },
        "Missing or invalid graphId in path (expected providerId:graphName)"
      );
      return NextResponse.json({ error: "Graph not found" }, { status: 404 });
    }
    const graphId = rawGraphId as `${string}:${string}`;

    // --- 3. Idempotency-Key header (required) ---
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) {
      log.warn("Missing Idempotency-Key header");
      return NextResponse.json(
        { error: "Idempotency-Key header required" },
        { status: 400 }
      );
    }

    // --- 4. Parse request body ---
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const parseResult = InternalGraphRunInputSchema.safeParse(body);
    if (!parseResult.success) {
      log.warn({ errors: parseResult.error.issues }, "Invalid request body");
      return NextResponse.json(
        { error: "Invalid request body", details: parseResult.error.issues },
        { status: 400 }
      );
    }

    const {
      executionGrantId = null,
      input,
      runId: providedRunId,
    } = parseResult.data;
    const runId = providedRunId ?? randomUUID();

    // --- 5. Compute request hash for idempotency ---
    const requestHash = computeRequestHash(graphId, input);

    // --- 6. Check idempotency ---
    const idempotencyResult =
      await container.executionRequestPort.checkIdempotency(
        idempotencyKey,
        requestHash
      );

    if (idempotencyResult.status === "cached") {
      // Already processed - return cached result with original outcome
      const cached = idempotencyResult.request;
      log.info(
        { idempotencyKey, runId: cached.runId, ok: cached.ok },
        "Returning cached result"
      );
      // Use explicit branching for discriminated union type narrowing
      if (cached.ok) {
        const cachedResponse: InternalGraphRunOutput = {
          ok: true,
          runId: cached.runId,
          traceId: cached.traceId,
        };
        return NextResponse.json(cachedResponse, { status: 200 });
      } else {
        const cachedResponse: InternalGraphRunOutput = {
          ok: false,
          runId: cached.runId,
          traceId: cached.traceId,
          error: cached.errorCode ?? "internal",
        };
        return NextResponse.json(cachedResponse, { status: 200 });
      }
    }

    if (idempotencyResult.status === "pending") {
      // Execution in progress - return 409 Conflict to signal retry later
      const pending = idempotencyResult.request;
      log.info(
        { idempotencyKey, runId: pending.runId },
        "Execution already in progress"
      );
      return NextResponse.json(
        {
          error: "Execution in progress",
          message:
            "Request with this Idempotency-Key is currently being processed",
          runId: pending.runId,
        },
        { status: 409 }
      );
    }

    if (idempotencyResult.status === "mismatch") {
      // Same idempotency key but different payload - reject
      log.warn(
        {
          idempotencyKey,
          existingHash: idempotencyResult.existingHash,
          providedHash: idempotencyResult.providedHash,
        },
        "Idempotency key conflict"
      );
      return NextResponse.json(
        {
          error: "Idempotency conflict",
          message:
            "Request with same Idempotency-Key but different payload already processed",
        },
        { status: 422 }
      );
    }

    // --- 7/8. Resolve execution identity ---
    let actorUserId: string;
    let billingAccountId: string;
    let virtualKeyId: string;
    let stateKey: string | undefined;
    let sessionId: string | undefined;

    if (executionGrantId) {
      // Scheduled / grant-backed runs: validate grant (defense-in-depth)
      let grant: Awaited<
        ReturnType<
          typeof container.executionGrantWorkerPort.validateGrantForGraph
        >
      >;
      try {
        grant = await container.executionGrantWorkerPort.validateGrantForGraph(
          SYSTEM_ACTOR,
          executionGrantId,
          graphId
        );
      } catch (error) {
        if (isGrantNotFoundError(error)) {
          log.warn({ executionGrantId }, "Grant not found");
          return NextResponse.json(
            { error: "Grant not found" },
            { status: 403 }
          );
        }
        if (isGrantExpiredError(error)) {
          log.warn({ executionGrantId }, "Grant expired");
          return NextResponse.json({ error: "Grant expired" }, { status: 403 });
        }
        if (isGrantRevokedError(error)) {
          log.warn({ executionGrantId }, "Grant revoked");
          return NextResponse.json({ error: "Grant revoked" }, { status: 403 });
        }
        if (isGrantScopeMismatchError(error)) {
          log.warn({ executionGrantId, graphId }, "Grant scope mismatch");
          return NextResponse.json(
            { error: "Grant scope mismatch" },
            { status: 403 }
          );
        }
        throw error;
      }

      const billingAccount =
        await container.serviceAccountService.getBillingAccountById(
          grant.billingAccountId
        );
      if (!billingAccount) {
        log.error(
          { billingAccountId: grant.billingAccountId },
          "Billing account not found"
        );
        return NextResponse.json(
          { error: "Billing account not found" },
          { status: 500 }
        );
      }

      actorUserId = grant.userId;
      billingAccountId = grant.billingAccountId;
      virtualKeyId = billingAccount.defaultVirtualKeyId;

      // Per bug.0197: hash the full idempotencyKey (scheduleId:scheduledFor) so each
      // execution slot gets its own isolated thread instead of accumulating in one.
      stateKey = createHash("sha256")
        .update(idempotencyKey, "utf8")
        .digest("hex");
      sessionId = `sched:${billingAccountId}:s:${stateKey.slice(0, 32)}`;
    } else {
      // API-triggered runs: execution context is provided in payload.
      const inputUserId =
        typeof input.actorUserId === "string" ? input.actorUserId : null;
      const inputBillingAccountId =
        typeof input.billingAccountId === "string"
          ? input.billingAccountId
          : null;
      const inputVirtualKeyId =
        typeof input.virtualKeyId === "string" ? input.virtualKeyId : null;
      if (!inputUserId || !inputBillingAccountId || !inputVirtualKeyId) {
        return NextResponse.json(
          {
            error:
              "API-originated run requires actorUserId, billingAccountId, and virtualKeyId in payload",
          },
          { status: 400 }
        );
      }

      actorUserId = inputUserId;
      billingAccountId = inputBillingAccountId;
      virtualKeyId = inputVirtualKeyId;
      stateKey =
        typeof input.stateKey === "string" && input.stateKey.length > 0
          ? input.stateKey
          : undefined;
      sessionId = stateKey
        ? `ba:${billingAccountId}:s:${createHash("sha256")
            .update(stateKey, "utf8")
            .digest("hex")
            .slice(0, 32)}`
        : `run:${runId}`;
    }

    // --- 9. Execute graph ---
    // Use OTel trace ID (same one passed to executor, used by Langfuse decorator)
    const traceId = ctx.traceId;

    log.info(
      { graphId, runId, executionGrantId, idempotencyKey, traceId },
      "Starting scheduled graph execution"
    );

    // --- 9a. Create pending idempotency record BEFORE execution ---
    // This ensures the record exists even if execution fails/times out
    await container.executionRequestPort.createPendingRequest(
      idempotencyKey,
      requestHash,
      runId,
      traceId
    );

    // --- 9b. Patch stateKey onto graph_runs record (bug.0197) ---
    // stateKey is derived here (internal API) but graph_runs was created by
    // createGraphRunActivity before this route is called. Patch it so dashboard
    // can link runs to their threads.
    if (stateKey && executionGrantId) {
      try {
        await container.graphRunRepository.patchRunStateKey(
          SYSTEM_ACTOR,
          runId,
          stateKey
        );
      } catch (patchErr) {
        log.warn(
          { runId, stateKey, err: patchErr },
          "Failed to patch stateKey on graph_runs — non-fatal"
        );
      }
    }

    capture({
      event: AnalyticsEvents.AGENT_RUN_REQUESTED,
      identity: {
        userId: actorUserId,
        sessionId: sessionId ?? runId,
        tenantId: billingAccountId,
        traceId,
      },
      properties: {
        run_id: runId,
        agent_type: graphId,
        entrypoint: "schedule",
      },
    });

    // Parse input for graph execution
    const messageDtos = Array.isArray(input.messages)
      ? input.messages
      : typeof input.message === "string"
        ? [{ role: "user", content: input.message }]
        : [];

    // ModelRef is required - parse from workflow input
    const modelRef = (() => {
      // New format: modelRef object
      if (input.modelRef && typeof input.modelRef === "object") {
        const ref = input.modelRef as {
          providerKey?: string;
          modelId?: string;
          connectionId?: string;
        };
        if (
          typeof ref.providerKey === "string" &&
          typeof ref.modelId === "string"
        ) {
          return {
            providerKey: ref.providerKey,
            modelId: ref.modelId,
            ...(typeof ref.connectionId === "string"
              ? { connectionId: ref.connectionId }
              : {}),
          };
        }
      }
      log.error("Missing required modelRef field");
      return null;
    })();
    if (!modelRef) {
      return NextResponse.json(
        { error: "modelRef field is required" },
        { status: 400 }
      );
    }

    log.info(
      {
        providerKey: modelRef.providerKey,
        modelId: modelRef.modelId,
        connectionId: modelRef.connectionId ?? null,
      },
      "Parsed modelRef for graph execution"
    );

    const accountService = container.accountsForUser(toUserId(actorUserId));

    // Create preflight credit check closure
    // Per CREDITS_ENFORCED_AT_EXECUTION_PORT: decorator handles all execution paths
    const preflightCheckFn: PreflightCreditCheckFn = (
      billingAccountId,
      m,
      msgs
    ) =>
      preflightCreditCheck({
        billingAccountId,
        messages: [...msgs],
        model: m,
        accountService,
      });

    // Create graph executor and run
    const executor = createGraphExecutor(executeStream, toUserId(actorUserId));
    const scopedExecutor = createScopedGraphExecutor({
      executor,
      preflightCheckFn,
      commitByoUsage: async (fact, log) => {
        await commitUsageFact(
          fact,
          {
            runId: fact.runId,
            attempt: fact.attempt,
            ingressRequestId: fact.runId,
          },
          accountService,
          log as import("pino").Logger
        );
      },
      billing: {
        billingAccountId,
        virtualKeyId,
      },
      resolver: container.providerResolver,
      actorId: actorUserId,
      ...(container.connectionBroker
        ? { broker: container.connectionBroker }
        : {}),
    });
    const messages = (
      messageDtos as Array<{
        role: string;
        content: string;
        toolCalls?: Array<{ id: string; name: string; arguments: string }>;
        toolCallId?: string;
      }>
    ).map((m) => ({
      role: m.role as "user" | "assistant" | "system" | "tool",
      content: m.content,
      ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
      ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
    }));
    // Forward responseFormat if provided (enables structuredOutput in GraphRunResult).
    const responseFormat = resolveResponseFormat(input);

    const result = scopedExecutor.runGraph(
      {
        runId,
        graphId,
        messages,
        modelRef,
        ...(stateKey !== undefined && { stateKey }),
        ...(responseFormat !== undefined && { responseFormat }),
      },
      {
        actorUserId,
        requestId: runId,
        ...(sessionId ? { sessionId } : {}),
      }
    );

    // Consume stream, publish events to Redis, and wait for final result.
    // Per PUMP_TO_COMPLETION_VIA_REDIS: events reach Redis regardless of SSE subscribers.
    // Per STREAM_PUBLISH_IN_EXECUTION_LAYER: Redis publishing happens here, not in Temporal activity.
    // Wrapped in try/catch so preflight credit failures (thrown during stream
    // iteration by PreflightCreditCheckDecorator) finalize the idempotency
    // record cleanly instead of leaving it "pending" forever.
    const { runStream } = container;
    let final: Awaited<typeof result.final>;
    // Hold back the done event — we enrich it with GraphFinal data after stream drain.
    let pendingDone: { type: "done" } | null = null;
    // Accumulate persistence-relevant events only (SHARED_EVENT_ASSEMBLER).
    // text_delta not needed — assembler uses assistant_final for full content.
    const PERSIST_EVENT_TYPES = new Set([
      "assistant_final",
      "tool_call_start",
      "tool_call_result",
    ]);
    const accumulatedEvents: AiEvent[] = [];
    try {
      for await (const event of result.stream) {
        if (PERSIST_EVENT_TYPES.has(event.type)) {
          accumulatedEvents.push(event);
        }
        // Publish each event to Redis Stream for SSE subscribers.
        // Per REDIS_IS_STREAM_PLANE: Redis loss = stream interruption, not data loss.
        // Publish failures are logged, not thrown — execution must complete for billing safety.
        try {
          if (event.type === "done") {
            // Buffer done — enrich after stream drain when result.final resolves.
            pendingDone = event;
          } else {
            await runStream.publish(runId, event);
            if (event.type === "error") {
              await runStream.expire(runId, RUN_STREAM_DEFAULT_TTL_SECONDS);
            }
          }
        } catch (publishErr) {
          log.warn(
            { runId, eventType: event.type, err: publishErr },
            "Redis stream publish failed — stream degraded, execution continues"
          );
        }
      }

      final = await result.final;

      // Enrich and publish the buffered done event with usage from GraphFinal.
      if (pendingDone) {
        try {
          const enriched = {
            ...pendingDone,
            ...(final.ok && final.usage ? { usage: final.usage } : {}),
            ...(final.ok && final.finishReason
              ? { finishReason: final.finishReason }
              : {}),
          };
          await runStream.publish(runId, enriched);
          await runStream.expire(runId, RUN_STREAM_DEFAULT_TTL_SECONDS);
        } catch (publishErr) {
          log.warn(
            { runId, err: publishErr },
            "Redis publish of enriched done failed"
          );
        }
      }

      // --- Thread persistence (PERSIST_AFTER_PUMP) ---
      // Per STATEKEY_NULLABLE: only persist when stateKey + user context present.
      // Per TERMINAL_ONLY_PERSIST: assembler returns null if no assistant_final.
      // Per IDEMPOTENT_THREAD_PERSIST: message ID = assistant-{runId}, skip if already in thread.
      if (stateKey && actorUserId) {
        try {
          const assistantMsg = assembleAssistantMessage(
            runId,
            accumulatedEvents
          );
          if (assistantMsg) {
            const threadPersistence = container.threadPersistenceForUser(
              toUserId(actorUserId)
            );
            const existing = await threadPersistence.loadThread(
              actorUserId,
              stateKey
            );

            // Idempotent guard: skip if this run's assistant message is already persisted
            const alreadyPersisted = existing.some(
              (m) => m.id === assistantMsg.id
            );
            if (!alreadyPersisted) {
              const thread = [...existing, assistantMsg];
              try {
                await threadPersistence.saveThread(
                  actorUserId,
                  stateKey,
                  redactSecretsInMessages(thread),
                  existing.length
                );
                log.info(
                  { runId, stateKey, messageCount: thread.length },
                  "Thread persisted by execution layer"
                );
              } catch (persistErr) {
                if (persistErr instanceof ThreadConflictError) {
                  // Retry once with fresh load (concurrent write from chat route Phase 1)
                  const reloaded = await threadPersistence.loadThread(
                    actorUserId,
                    stateKey
                  );
                  if (!reloaded.some((m) => m.id === assistantMsg.id)) {
                    await threadPersistence.saveThread(
                      actorUserId,
                      stateKey,
                      redactSecretsInMessages([...reloaded, assistantMsg]),
                      reloaded.length
                    );
                    log.info(
                      { runId, stateKey },
                      "Thread persisted (retry after conflict)"
                    );
                  }
                } else {
                  throw persistErr;
                }
              }
            }
          }
        } catch (threadErr) {
          // Thread persistence failure must not block execution result.
          // Billing + run record are more critical; log and continue.
          log.error(
            { runId, stateKey, err: threadErr },
            "Thread persistence failed — execution result unaffected"
          );
        }
      }
    } catch (error) {
      const errorCode = isInsufficientCreditsPortError(error)
        ? "insufficient_credits"
        : "internal";

      log.warn(
        { runId, graphId, errorCode, err: error },
        "Graph execution rejected before start"
      );

      // Publish error to Redis so facade subscribers don't hang.
      try {
        await runStream.publish(runId, {
          type: "error",
          error: errorCode,
        });
        await runStream.expire(runId, RUN_STREAM_DEFAULT_TTL_SECONDS);
      } catch (publishErr) {
        log.warn(
          { runId, err: publishErr },
          "Redis error publish failed after preflight rejection"
        );
      }

      capture({
        event: AnalyticsEvents.AGENT_RUN_FAILED,
        identity: {
          userId: actorUserId,
          sessionId: sessionId ?? runId,
          tenantId: billingAccountId,
          traceId,
        },
        properties: {
          run_id: runId,
          error_class: errorCode,
          error_code: errorCode,
        },
      });

      // --- 10a. Finalize idempotency record with failure ---
      await container.executionRequestPort.finalizeRequest(idempotencyKey, {
        ok: false,
        errorCode,
      });

      const errorResponse: InternalGraphRunOutput = {
        ok: false,
        runId,
        traceId,
        error: errorCode,
      };
      return NextResponse.json(errorResponse, { status: 200 });
    }

    // --- 10. Finalize idempotency record with outcome ---
    await container.executionRequestPort.finalizeRequest(idempotencyKey, {
      ok: final.ok,
      errorCode: final.error ?? null,
    });

    // --- 11. Return result ---
    if (final.ok) {
      log.info({ runId, graphId }, "Scheduled graph execution completed");
      capture({
        event: AnalyticsEvents.AGENT_RUN_COMPLETED,
        identity: {
          userId: actorUserId,
          sessionId: sessionId ?? runId,
          tenantId: billingAccountId,
          traceId,
        },
        properties: {
          run_id: runId,
          success: true,
          agent_type: graphId,
        },
      });
      const successResponse: InternalGraphRunOutput = {
        ok: true,
        runId,
        traceId,
        ...(final.structuredOutput !== undefined && {
          structuredOutput: final.structuredOutput,
        }),
      };
      return NextResponse.json(successResponse, { status: 200 });
    } else {
      log.warn(
        { runId, graphId, error: final.error },
        "Scheduled graph execution failed"
      );
      capture({
        event: AnalyticsEvents.AGENT_RUN_FAILED,
        identity: {
          userId: actorUserId,
          sessionId: sessionId ?? runId,
          tenantId: billingAccountId,
          traceId,
        },
        properties: {
          run_id: runId,
          error_class: final.error ?? "internal",
          error_code: final.error ?? "internal",
        },
      });
      const errorResponse: InternalGraphRunOutput = {
        ok: false,
        runId,
        traceId,
        error: final.error ?? "internal",
      };
      return NextResponse.json(errorResponse, { status: 200 });
    }
  }
);

// ---------------------------------------------------------------------------
// Response format resolution
// ---------------------------------------------------------------------------

/** Known response format schemas, keyed by schemaId. */
const RESPONSE_FORMAT_SCHEMAS: Record<string, z.ZodType> = {
  "evaluation-output": z.object({
    metrics: z.array(
      z.object({
        metric: z.string(),
        value: z.number().min(0).max(1),
        observations: z.array(z.string()),
      })
    ),
    summary: z.string(),
  }),
};

/**
 * Resolve responseFormat from graph input.
 * Supports two modes:
 * 1. schemaId: resolves to a known Zod schema (for Temporal/HTTP callers that can't serialize Zod)
 * 2. schema: pass-through (for in-process callers that can provide Zod directly)
 */
function resolveResponseFormat(
  input: Record<string, unknown>
): { prompt?: string; schema: unknown } | undefined {
  if (
    input.responseFormat == null ||
    typeof input.responseFormat !== "object"
  ) {
    return undefined;
  }

  const rf = input.responseFormat as Record<string, unknown>;

  // Mode 1: schemaId lookup (Temporal/HTTP callers)
  if (typeof rf.schemaId === "string") {
    const schema = RESPONSE_FORMAT_SCHEMAS[rf.schemaId];
    if (!schema) return undefined;
    return {
      ...(typeof rf.prompt === "string" ? { prompt: rf.prompt } : {}),
      schema,
    };
  }

  // Mode 2: schema pass-through (in-process callers)
  if (rf.schema !== undefined) {
    return {
      ...(typeof rf.prompt === "string" ? { prompt: rf.prompt } : {}),
      schema: rf.schema,
    };
  }

  return undefined;
}
