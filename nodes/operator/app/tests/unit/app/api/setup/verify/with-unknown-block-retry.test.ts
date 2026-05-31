// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/setup/with-unknown-block-retry`
 * Purpose: Unit tests for the block-not-ready retry helper.
 * Scope: Tests the matcher (cross-provider block-not-ready strings) + retry behavior contracts.
 * Invariants: Retries ONLY on block-not-ready errors; bounded attempts; exponential backoff.
 * Side-effects: none (fake timers).
 * Links: src/app/api/setup/verify/with-unknown-block-retry.ts
 * @public
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  isBlockNotReadyError,
  withUnknownBlockRetry,
} from "@/app/api/setup/verify/with-unknown-block-retry";

describe("isBlockNotReadyError", () => {
  it("matches the Alchemy Unknown-block error", () => {
    const err = new Error(
      'HTTP request failed.\n\nStatus: 400\nDetails: {"code":3,"message":"Unknown block"}'
    );
    expect(isBlockNotReadyError(err)).toBe(true);
  });

  it("matches the public mainnet.base.org block-not-found error (bug.5082 variant)", () => {
    const err = new Error(
      "Failed to verify CogniSignal.DAO(): Requested resource not found.\n\nURL: https://mainnet.base.org\nDetails: block not found: 0x2c87340\nVersion: viem@2.39.3"
    );
    expect(isBlockNotReadyError(err)).toBe(true);
  });

  it("matches geth/reth header-not-found", () => {
    expect(isBlockNotReadyError(new Error("header not found"))).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isBlockNotReadyError(new Error("BLOCK NOT FOUND"))).toBe(true);
  });

  it("does not match other errors", () => {
    expect(isBlockNotReadyError(new Error("Transaction not found"))).toBe(
      false
    );
    expect(isBlockNotReadyError(new Error("nonce too low"))).toBe(false);
    expect(isBlockNotReadyError("string error")).toBe(false);
    expect(isBlockNotReadyError(undefined)).toBe(false);
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
