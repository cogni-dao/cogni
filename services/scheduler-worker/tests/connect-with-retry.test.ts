// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/scheduler-worker/tests/connect-with-retry.test`
 * Purpose: Unit tests for the `connectWithRetry` retry LOOP that wraps the
 *   Temporal `NativeConnection.connect` call. The loop — not just the
 *   `isTransientConnectError` predicate — is the fix that stops a transient
 *   boot-DNS blip from crashlooping the scheduler-worker and storm-degrading the
 *   shared k3s VM → fleet 502 (incident 2026-06-30, PR #1911). The candidate-a
 *   flight booted first-try so the retry path never executed in the wild; these
 *   tests inject a fake `connect` + instant `sleep` to prove recover / no-retry /
 *   exhaust deterministically.
 * Scope: Pure loop logic with injected dependencies; no Temporal, no real timers.
 * @internal
 */

import type { NativeConnection } from "@temporalio/worker";
import { describe, expect, it, vi } from "vitest";
import { connectWithRetry } from "../src/worker.js";

// Minimal Logger stub — connectWithRetry only calls .warn, but provide the rest.
function makeFakeLogger() {
  const logger = {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    child: () => logger,
    // biome-ignore lint/suspicious/noExplicitAny: test stub for the Logger shape
  } as any;
  return logger;
}

// Instant sleep so the loop runs with zero real delay.
const noopSleep = async (): Promise<void> => {};

// The exact prod transient shape (incident 2026-06-30): a TransportError whose
// message contains "Temporary failure in name resolution".
function transientError(): Error {
  return Object.assign(
    new Error('dns error", "Temporary failure in name resolution'),
    { name: "TransportError" }
  );
}

// A sentinel "connection" — connectWithRetry returns whatever connect resolves.
const sentinelConnection = {
  __sentinel: "native-connection",
} as unknown as NativeConnection;

describe("connectWithRetry loop", () => {
  it("recovers: retries transient failures then returns the connection", async () => {
    const connect = vi
      .fn<() => Promise<NativeConnection>>()
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError())
      .mockResolvedValueOnce(sentinelConnection);

    const result = await connectWithRetry(connect, makeFakeLogger(), {
      sleep: noopSleep,
    });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(result).toBe(sentinelConnection);
  });

  it("no-retry on permanent: rethrows immediately after one attempt", async () => {
    const permanent = new Error("invalid argument");
    const connect = vi
      .fn<() => Promise<NativeConnection>>()
      .mockRejectedValue(permanent);

    await expect(
      connectWithRetry(connect, makeFakeLogger(), { sleep: noopSleep })
    ).rejects.toBe(permanent);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("exhausts: retries up to maxAttempts then rethrows the last error", async () => {
    const last = transientError();
    const connect = vi
      .fn<() => Promise<NativeConnection>>()
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(last);

    await expect(
      connectWithRetry(connect, makeFakeLogger(), {
        maxAttempts: 3,
        sleep: noopSleep,
      })
    ).rejects.toBe(last);
    expect(connect).toHaveBeenCalledTimes(3);
  });
});
