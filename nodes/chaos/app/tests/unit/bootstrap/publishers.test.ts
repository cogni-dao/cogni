// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/publishers`
 * Purpose: Unit tests for startProcessHealthPublisher — event shape, error handling, abort.
 * Scope: Mocked NodeStreamPort and logger. No real Redis, no real timers.
 * Invariants:
 *   - PROCESS_HEALTH_ONLY: Publisher produces only ProcessHealthEvent
 * Side-effects: none (mocked port + fake timers)
 * Links: src/bootstrap/publishers.ts
 * @internal
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startProcessHealthPublisher } from "@/bootstrap/publishers";

function createMockPort() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(),
    streamLength: vi.fn(),
  };
}

function createMockLogger() {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
  };
}

describe("startProcessHealthPublisher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("publishes ProcessHealthEvent immediately on start", async () => {
    const port = createMockPort();
    const logger = createMockLogger();
    const controller = new AbortController();

    startProcessHealthPublisher({
      port: port as never,
      streamKey: "node:test:events",
      signal: controller.signal,
      logger: logger as never,
      environment: "test",
    });

    // Flush the immediate void publish()
    await vi.advanceTimersByTimeAsync(0);

    expect(port.publish).toHaveBeenCalledTimes(1);
    const firstCall = port.publish.mock.calls[0];
    if (!firstCall) throw new Error("expected publish call");
    const event = firstCall[1];

    expect(event.type).toBe("process_health");
    expect(event.source).toBe("process-metrics");
    expect(event.environment).toBe("test");
    expect(typeof event.timestamp).toBe("string");
    expect(event.heapUsedMb).toBeGreaterThan(0);
    expect(event.rssMb).toBeGreaterThan(0);
    expect(typeof event.uptimeSeconds).toBe("number");
    expect(typeof event.eventLoopDelayMs).toBe("number");

    controller.abort();
  });

  it("publishes again after 60s interval", async () => {
    const port = createMockPort();
    const logger = createMockLogger();
    const controller = new AbortController();

    startProcessHealthPublisher({
      port: port as never,
      streamKey: "node:test:events",
      signal: controller.signal,
      logger: logger as never,
      environment: "test",
    });

    await vi.advanceTimersByTimeAsync(0); // initial publish
    expect(port.publish).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000); // 60s later
    expect(port.publish).toHaveBeenCalledTimes(2);

    controller.abort();
  });

  it("logs warning and continues on publish error", async () => {
    const port = createMockPort();
    port.publish.mockRejectedValueOnce(new Error("Redis down"));
    const logger = createMockLogger();
    const controller = new AbortController();

    startProcessHealthPublisher({
      port: port as never,
      streamKey: "node:test:events",
      signal: controller.signal,
      logger: logger as never,
      environment: "test",
    });

    await vi.advanceTimersByTimeAsync(0); // initial publish (fails)
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const firstWarn = logger.warn.mock.calls[0];
    if (!firstWarn) throw new Error("expected warn call");
    expect(firstWarn[0]).toHaveProperty("err");

    // Next interval still fires
    port.publish.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(port.publish).toHaveBeenCalledTimes(2);

    controller.abort();
  });

  it("stops interval on abort signal", async () => {
    const port = createMockPort();
    const logger = createMockLogger();
    const controller = new AbortController();

    startProcessHealthPublisher({
      port: port as never,
      streamKey: "node:test:events",
      signal: controller.signal,
      logger: logger as never,
      environment: "test",
    });

    await vi.advanceTimersByTimeAsync(0); // initial
    controller.abort();

    await vi.advanceTimersByTimeAsync(120_000); // two intervals
    // Should still be 1 (initial only, no interval fires after abort)
    expect(port.publish).toHaveBeenCalledTimes(1);
  });
});
