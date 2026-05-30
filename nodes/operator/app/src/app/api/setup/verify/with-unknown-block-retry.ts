// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/setup/verify/with-unknown-block-retry`
 * Purpose: Retry helper for Alchemy multi-backend "Unknown block" lag on pinned-block reads.
 * Scope: Wraps a single RPC call; retries only on the `Unknown block` error pattern; bounded exponential backoff. Does not handle business logic.
 * Invariants: Bounded attempts; retries ONLY on Unknown-block error; all other errors surface immediately.
 * Side-effects: none (pure async helper)
 * Notes: Alchemy is load-balanced; one HTTP call hits a backend that has block N, the next can hit a backend that does not yet have it, returning HTTP 400 `{code:3, "Unknown block"}`. Block typically catches up within <1s.
 * Links: docs/spec/node-formation.md
 * @public
 */

export interface UnknownBlockRetryInfo {
  attempt: number;
  delayMs: number;
  err: Error;
}

export interface UnknownBlockRetryOptions {
  /** Total attempts including the first try. Default: 4. */
  maxAttempts?: number;
  /** Base delay for exponential backoff in ms. Default: 250. */
  baseDelayMs?: number;
  /** Called once per retry (not on the initial attempt). */
  onRetry?: (info: UnknownBlockRetryInfo) => void;
}

/**
 * Returns true if the error looks like Alchemy's cross-backend "Unknown block" lag.
 * Alchemy returns HTTP 400 with body `{code:3, message:"Unknown block"}`. viem
 * inlines the body in the error message, so a substring match is reliable across
 * `HttpRequestError` and any `RpcRequestError` wrapping.
 */
export function isUnknownBlockError(err: unknown): err is Error {
  return err instanceof Error && err.message.includes("Unknown block");
}

/**
 * Retries `fn` on transient Alchemy `Unknown block` errors with exponential backoff.
 * Default: 4 attempts × 250/500/1000ms ≈ 1.75s total tolerance — covers Alchemy's
 * typical sub-second cross-backend lag. Non-matching errors are re-thrown immediately.
 */
export async function withUnknownBlockRetry<T>(
  fn: () => Promise<T>,
  opts: UnknownBlockRetryOptions = {}
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const baseDelayMs = opts.baseDelayMs ?? 250;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isUnknownBlockError(err) || attempt === maxAttempts) throw err;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, delayMs, err });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
