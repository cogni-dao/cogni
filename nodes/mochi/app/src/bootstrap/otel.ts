// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/otel`
 * Purpose: OpenTelemetry helpers for creating and managing root spans in route handlers.
 * Scope: Provide withRootSpan() wrapper for request handlers; extract trace context. Does NOT initialize SDK.
 * Invariants:
 *   - Root span bound to context via context.with() for proper trace propagation
 *   - span.recordException(error) called on failures before setting ERROR status
 *   - span.end() in finally block (always executed)
 *   - Trace ID extracted from spanContext (MUST be non-zero when SDK is running)
 * Side-effects: IO (OTel span creation and recording)
 * Notes: SDK initialized in instrumentation.ts, not here.
 * Links: AI_SETUP_SPEC.md, instrumentation.ts
 * @public
 */

import { context, type Span, SpanStatusCode, trace } from "@opentelemetry/api";

/** Zero trace ID (indicates SDK not properly initialized or noop tracer) */
const ZERO_TRACE_ID = "00000000000000000000000000000000";

/** Default tracer name for Cogni app */
const TRACER_NAME = "cogni-template";

/**
 * Result type from withRootSpan callback.
 */
export interface RootSpanContext {
  /** OTel trace ID (hex string, 32 chars). Non-zero when SDK is running. */
  traceId: string;
  /** The active span for recording exceptions or adding attributes. */
  span: Span;
}

/**
 * Execute a handler within a root span context.
 *
 * Creates a new root span, binds it to OTel context via context.with(),
 * and ensures proper cleanup (span.end() in finally, recordException on error).
 *
 * Per AI_SETUP_SPEC.md:
 * - Uses context.with(trace.setSpan(...)) for proper binding
 * - Child spans created inside handler share same trace_id
 * - span.recordException(error) called on failures
 * - span.end() in finally block
 *
 * @param name - Span name (e.g., "POST /api/v1/ai/completion")
 * @param attributes - Initial span attributes (e.g., { request_id, route_id })
 * @param handler - Async handler function receiving { traceId, span }
 * @returns Result of the handler function
 *
 * @example
 * ```ts
 * const result = await withRootSpan(
 *   "POST /api/v1/ai/completion",
 *   { request_id: reqId, route_id: "ai.completion" },
 *   async ({ traceId, span }) => {
 *     // traceId is the OTel trace ID (hex string)
 *     // Any child spans created here share the same trace_id
 *     return await handleRequest(traceId);
 *   }
 * );
 * ```
 */
export async function withRootSpan<T>(
  name: string,
  attributes: Record<string, string>,
  handler: (ctx: RootSpanContext) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(name, { attributes });

  // Extract trace ID from span context
  const spanContext = span.spanContext();
  const traceId = spanContext.traceId;

  // Bind span to context so child spans inherit the trace_id
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      return await handler({ traceId, span });
    } catch (error) {
      // Record exception before setting error status (per spec)
      span.recordException(
        error instanceof Error ? error : new Error(String(error))
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw error;
    } finally {
      // Always end the span (per spec)
      span.end();
    }
  });
}

/**
 * Get the current trace ID from the active OTel context.
 *
 * Returns the trace ID if inside a span context, or ZERO_TRACE_ID if:
 * - No active span (outside withRootSpan)
 * - SDK not initialized (noop tracer)
 *
 * @returns Trace ID hex string (32 chars)
 */
export function getCurrentTraceId(): string {
  const span = trace.getActiveSpan();
  if (!span) {
    return ZERO_TRACE_ID;
  }
  return span.spanContext().traceId;
}

/** Regex for valid OTel trace ID: 32 lowercase hex characters */
const TRACE_ID_REGEX = /^[0-9a-f]{32}$/;

/**
 * Check if a trace ID is valid (non-zero, valid hex format).
 *
 * Zero trace ID indicates SDK not properly started or noop tracer.
 * Use this to verify OTel is working correctly in tests.
 *
 * @param traceId - Trace ID to check
 * @returns true if trace ID is valid lowercase hex and non-zero
 */
export function isValidTraceId(traceId: string): boolean {
  return TRACE_ID_REGEX.test(traceId) && traceId !== ZERO_TRACE_ID;
}

/**
 * Create a child span within the current context.
 *
 * Child spans inherit trace_id from parent span (set via context.with in withRootSpan).
 * Use for instrumenting sub-operations (e.g., LLM calls, DB queries).
 *
 * @param name - Span name (e.g., "litellm.completion")
 * @param handler - Async handler function receiving the child span
 * @returns Result of the handler function
 */
export async function withChildSpan<T>(
  name: string,
  handler: (span: Span) => Promise<T>
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  const span = tracer.startSpan(name);

  try {
    return await context.with(trace.setSpan(context.active(), span), () =>
      handler(span)
    );
  } catch (error) {
    span.recordException(
      error instanceof Error ? error : new Error(String(error))
    );
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
}
