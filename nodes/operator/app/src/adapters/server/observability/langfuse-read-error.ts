// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/langfuse-read-error`
 * Purpose: Preserve safe dependency failure semantics across native reads and ownership checks.
 * Scope: Public codes/status only; no upstream messages, bodies, credentials or URLs.
 * Invariants: Backend failure is distinct from a valid ownership non-match.
 * Side-effects: none
 * Links: task.5319, observability/langfuse-reader.adapter.ts
 * @internal
 */
export class LangfuseReadError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly retryAfter?: string
  ) {
    super(code);
  }
}

export function safeRetryAfter(value: string | null): string | undefined {
  if (!value) return undefined;
  if (/^\d{1,5}$/.test(value)) return value;
  // Retry-After also permits an HTTP date. Reject arbitrary upstream header text.
  if (
    /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value
    ) &&
    Number.isFinite(Date.parse(value))
  )
    return value;
  return undefined;
}

export function safeDependencyFailure(
  error: unknown,
  signal: AbortSignal
): LangfuseReadError {
  if (error instanceof LangfuseReadError) return error;
  if (
    signal.aborted ||
    (error instanceof Error &&
      ["TimeoutError", "AbortError"].includes(error.name))
  ) {
    return new LangfuseReadError("observability_upstream_timeout", 504);
  }
  return new LangfuseReadError("observability_upstream_error", 502);
}
