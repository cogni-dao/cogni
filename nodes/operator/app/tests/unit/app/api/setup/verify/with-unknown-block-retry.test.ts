// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/setup/with-unknown-block-retry`
 * Purpose: Unit tests for the Alchemy Unknown-block retry helper.
 * Scope: Tests retry behavior contracts (transient success, non-matching error passthrough, exhaustion, bounded backoff).
 * Invariants: Retries ONLY on Unknown-block; bounded attempts; exponential backoff.
 * Side-effects: none (fake timers).
 * Links: src/app/api/setup/verify/with-unknown-block-retry.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isUnknownBlockError,
  withUnknownBlockRetry,
} from "@/app/api/setup/verify/with-unknown-block-retry";

describe("isUnknownBlockError", () => {
  it("matches the Alchemy Unknown-block error message verbatim", () => {
    const err = new Error(
      'HTTP request failed.\n\nStatus: 400\nDetails: {"code":3,"message":"Unknown block"}'
    );
    expect(isUnknownBlockError(err)).toBe(true);
  });

  it("does not match other errors", () => {
    expect(isUnknownBlockError(new Error("Transaction not found"))).toBe(false);
    expect(isUnknownBlockError(new Error("nonce too low"))).toBe(false);
    expect(isUnknownBlockError("string error")).toBe(false);
    expect(isUnknownBlockError(undefined)).toBe(false);
  });
});

describe("withUnknownBlockRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const onRetry = vi.fn();
    const promise = withUnknownBlockRetry(fn, { onRetry });
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries on Unknown-block errors and eventually succeeds", async () => {
    const unknown = new Error('{"code":3,"message":"Unknown block"}');
    const fn = vi
      .fn()
      .mockRejectedValueOnce(unknown)
      .mockRejectedValueOnce(unknown)
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    const promise = withUnknownBlockRetry(fn, { onRetry, baseDelayMs: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, {
      attempt: 1,
      delayMs: 10,
      err: unknown,
    });
    expect(onRetry).toHaveBeenNthCalledWith(2, {
      attempt: 2,
      delayMs: 20,
      err: unknown,
    });
  });

  it("re-throws non-matching errors immediately without retrying", async () => {
    const err = new Error("Transaction not found");
    const fn = vi.fn().mockRejectedValue(err);
    const onRetry = vi.fn();

    await expect(withUnknownBlockRetry(fn, { onRetry })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("re-throws the last Unknown-block error after exhausting all attempts", async () => {
    const unknown = new Error('{"code":3,"message":"Unknown block"}');
    const fn = vi.fn().mockRejectedValue(unknown);
    const onRetry = vi.fn();

    const promise = withUnknownBlockRetry(fn, {
      onRetry,
      maxAttempts: 3,
      baseDelayMs: 10,
    });
    // Attach rejection handler before advancing timers to avoid unhandled-rejection noise
    const rejection = expect(promise).rejects.toBe(unknown);
    await vi.runAllTimersAsync();
    await rejection;
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("uses exponential backoff between retries (default 250/500/1000ms)", async () => {
    const unknown = new Error("Unknown block");
    const fn = vi
      .fn()
      .mockRejectedValueOnce(unknown)
      .mockRejectedValueOnce(unknown)
      .mockRejectedValueOnce(unknown)
      .mockResolvedValue("ok");
    const onRetry = vi.fn();

    const promise = withUnknownBlockRetry(fn, { onRetry });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(onRetry.mock.calls.map((c) => c[0].delayMs)).toEqual([
      250, 500, 1000,
    ]);
  });
});
