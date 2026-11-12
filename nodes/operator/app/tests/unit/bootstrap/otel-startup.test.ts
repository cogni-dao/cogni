// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ start: vi.fn(), options: vi.fn() }));
vi.mock("@opentelemetry/sdk-node", () => ({
  tracing: { NoopSpanProcessor: class NoopSpanProcessor {} },
  NodeSDK: class {
    constructor(options: unknown) {
      mocks.options(options);
    }
    start() {
      return mocks.start();
    }
  },
}));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock("pino");
  vi.doUnmock("@/bootstrap/startup-preflight");
  mocks.start.mockReset();
  mocks.options.mockReset();
});

describe("native telemetry startup", () => {
  it("uses no-export processors while retaining the SDK provider", async () => {
    const { initOtelSdk } = await import("@/instrumentation.node");
    await expect(initOtelSdk({ failOnError: true })).resolves.toBe(true);
    expect(mocks.options).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentations: [],
        logRecordProcessors: [],
        spanProcessors: [
          expect.objectContaining({
            constructor: expect.objectContaining({ name: "NoopSpanProcessor" }),
          }),
        ],
      })
    );
  });
  it("retains a failed attempt for a later required caller", async () => {
    const original = new Error("private-sdk-detail");
    mocks.start.mockImplementation(() => {
      throw original;
    });
    vi.spyOn(process.stdout, "write").mockImplementation(
      (() => true) as typeof process.stdout.write
    );
    const { initOtelSdk } = await import("@/instrumentation.node");
    await expect(initOtelSdk({ failOnError: false })).resolves.toBe(false);
    await expect(initOtelSdk({ failOnError: true })).rejects.toBe(original);
    expect(mocks.start).toHaveBeenCalledOnce();
  });
  it("preserves trace IDs without exporting after 520 spans or shutdown", async () => {
    vi.useFakeTimers();
    const http = await import("node:http");
    const https = await import("node:https");
    const httpRequest = vi.spyOn(http.default, "request");
    const httpsRequest = vi.spyOn(https.default, "request");
    const fetchFn = vi.spyOn(globalThis, "fetch");
    const actual = await vi.importActual<
      typeof import("@opentelemetry/sdk-node")
    >("@opentelemetry/sdk-node");
    const sdk = new actual.NodeSDK({
      instrumentations: [],
      spanProcessors: [new actual.tracing.NoopSpanProcessor()],
      logRecordProcessors: [],
    });
    sdk.start();
    const tracer = actual.api.trace.getTracer("readiness-test");
    let traceId = "";
    for (let i = 0; i < 520; i++) {
      const span = tracer.startSpan("readyz");
      traceId = span.spanContext().traceId;
      span.end();
    }
    expect(traceId).not.toBe("00000000000000000000000000000000");
    await vi.advanceTimersByTimeAsync(6000);
    await sdk.shutdown();
    expect(httpRequest).not.toHaveBeenCalled();
    expect(httpsRequest).not.toHaveBeenCalled();
    expect(fetchFn).not.toHaveBeenCalled();
    actual.api.trace.disable();
    vi.useRealTimers();
  });

  it("exits once without logging the SDK failure on required startup", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    const original = new Error("PRIVATE_SDK_SENTINEL");
    mocks.start.mockImplementation(() => {
      throw original;
    });
    const lines: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { register } = await import("@/instrumentation.node");
    await expect(register()).rejects.toBe(original);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(JSON.stringify(lines)).not.toContain("PRIVATE_SDK_SENTINEL");
  });

  it.each([
    "construction",
    "emission",
  ] as const)("preserves fatal startup when logger %s throws", async (phase) => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NODE_ENV", "production");
    const original = new Error("startup failure");
    const diagnostic = new Error("diagnostic failure");
    mocks.start.mockImplementation(() => {
      throw original;
    });
    const emit = vi.fn(() => {
      throw diagnostic;
    });
    const construct = vi.fn(() => {
      if (phase === "construction") throw diagnostic;
      return { error: emit };
    });
    vi.doMock("@/bootstrap/startup-preflight", () => ({
      runStartupPreflight: vi.fn(),
    }));
    vi.doMock("pino", () => ({
      default: Object.assign(construct, {
        stdTimeFunctions: { isoTime: () => "" },
      }),
    }));
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    const { register } = await import("@/instrumentation.node");

    await expect(register()).rejects.toBe(original);
    expect(construct).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledTimes(phase === "emission" ? 1 : 0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("suppresses the native Redis error fallback without opening a connection", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const { createStreamRedisClient } = await import(
      "@/bootstrap/stream-redis-client"
    );
    const client = createStreamRedisClient("redis://127.0.0.1:1");
    (
      client as unknown as { silentEmit(event: string, error: Error): void }
    ).silentEmit("error", new Error("REDIS_PRIVATE_SENTINEL"));
    expect(consoleError).not.toHaveBeenCalled();
    client.disconnect();
  });
});
