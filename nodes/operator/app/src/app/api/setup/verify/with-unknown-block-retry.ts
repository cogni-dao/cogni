// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/setup/verify/with-unknown-block-retry`
 * Purpose: Retry helper for the "block not yet available on this RPC backend" race on pinned-block reads.
 * Scope: Wraps a single RPC call; retries only on the block-not-ready error family; bounded exponential backoff. Does not handle business logic.
 * Invariants: Bounded attempts; retries ONLY on block-not-ready errors; all other errors surface immediately.
 * Side-effects: none (pure async helper)
 * Notes: The client confirms a tx on its wallet RPC, then the server reads at that pinned block on a
 *   possibly-different RPC that has not indexed it yet. Each provider phrases the miss differently:
 *   Alchemy → `Unknown block` (code 3); public `mainnet.base.org` → `block not found` /
 *   `Requested resource not found`; geth → `header not found`. The block catches up within ~1s.
 * Links: docs/spec/node-formation.md, bug.5082
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
 * Substrings (case-insensitive) that mean "the pinned block is not on this RPC backend yet."
 * Provider-specific phrasings — viem inlines the RPC body into the error message, so a substring
 * match is reliable across `HttpRequestError` and `RpcRequestError` wrappings.
 */
const BLOCK_NOT_READY_PATTERNS = [
  "unknown block", // Alchemy (code 3)
  "block not found", // public mainnet.base.org
  "requested resource not found", // public mainnet.base.org wrapper
  "header not found", // geth / reth
] as const;

/**
 * Returns true if the error is a transient "block not yet indexed on this RPC" miss that a short
 * retry will resolve — NOT a permanent failure.
 */
export function isBlockNotReadyError(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return BLOCK_NOT_READY_PATTERNS.some((p) => msg.includes(p));
}

/**
 * Retries `fn` on transient block-not-ready RPC errors with exponential backoff.
 * Default: 4 attempts × 250/500/1000ms ≈ 1.75s total tolerance — covers typical sub-second
 * cross-backend lag. Non-matching errors are re-thrown immediately.
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
      if (!isBlockNotReadyError(err) || attempt === maxAttempts) throw err;
      const delayMs = baseDelayMs * 2 ** (attempt - 1);
      opts.onRetry?.({ attempt, delayMs, err });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}
