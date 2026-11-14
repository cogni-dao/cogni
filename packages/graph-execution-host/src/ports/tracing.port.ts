// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/ports/tracing.port`
 * Purpose: Minimal tracing port interface structurally compatible with LangfusePort.
 * Scope: Defines the 3 tracing methods the observability decorator calls. Does not contain implementations or runtime dependencies.
 * Invariants: PURE_LIBRARY — no env vars, no process lifecycle.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules, src/decorators/observability-executor.decorator.ts
 * @public
 */

export interface CreateTraceWithIOParams {
  traceId: string;
  sessionId?: string;
  userId?: string;
  input: unknown;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface TracingPort {
  createTraceWithIO(params: CreateTraceWithIOParams): string;
  updateTraceOutput(traceId: string, output: unknown): void;
  flush(): Promise<void>;
}

/**
 * Callback to retrieve the current OTel trace ID.
 * Injected to avoid a direct @opentelemetry/api dependency.
 * Default: returns the zero trace ID.
 */
export type GetTraceIdFn = () => string;
