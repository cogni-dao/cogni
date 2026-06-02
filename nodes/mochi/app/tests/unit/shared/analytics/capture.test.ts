// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/analytics/capture.test`
 * Purpose: Unit tests for PostHog product analytics capture wrapper.
 * Scope: Verify required field enforcement, buffering, initialization, and shutdown. Does NOT test actual HTTP calls.
 * Invariants: Every capture call must include userId and sessionId; missing fields are rejected.
 * Side-effects: none (uses in-memory mock client)
 * Notes: Tests cover init, capture, buffer, shutdown, and field validation.
 * Links: src/shared/analytics/capture.ts
 * @internal
 */

import {
  capture,
  getBuffer,
  initAnalytics,
  isAnalyticsInitialized,
  type PostHogClient,
  resetAnalytics,
  shutdownAnalytics,
} from "@cogni/node-shared";
import { afterEach, describe, expect, it, vi } from "vitest";

/** Creates a mock PostHog client that records calls. */
function createMockClient(): PostHogClient & {
  calls: Array<{
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    timestamp?: Date;
  }>;
  shutdownCalled: boolean;
} {
  const calls: Array<{
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
    timestamp?: Date;
  }> = [];
  let shutdownCalled = false;

  return {
    calls,
    get shutdownCalled() {
      return shutdownCalled;
    },
    capture(params) {
      calls.push(params);
    },
    async shutdown() {
      shutdownCalled = true;
    },
  };
}

describe("analytics capture", () => {
  afterEach(() => {
    resetAnalytics();
  });

  describe("initAnalytics", () => {
    it("should initialize with custom client", () => {
      const client = createMockClient();
      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc123",
        environment: "test",
        client,
      });
      expect(isAnalyticsInitialized()).toBe(true);
    });

    it("should be idempotent", () => {
      const client1 = createMockClient();
      const client2 = createMockClient();

      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc123",
        environment: "test",
        client: client1,
      });

      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc123",
        environment: "test",
        client: client2,
      });

      // Should use first client, not second
      capture({
        event: "cogni.test.event",
        identity: {
          userId: "user-1",
          sessionId: "session-1",
        },
      });

      expect(client1.calls).toHaveLength(1);
      expect(client2.calls).toHaveLength(0);
    });

    it("should flush buffered events on init", () => {
      // Capture before init (goes to buffer)
      capture({
        event: "cogni.test.buffered",
        identity: {
          userId: "user-1",
          sessionId: "session-1",
        },
      });

      expect(getBuffer()).toHaveLength(1);

      const client = createMockClient();
      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc123",
        environment: "test",
        client,
      });

      // Buffer should be flushed to client
      expect(getBuffer()).toHaveLength(0);
      expect(client.calls).toHaveLength(1);
      expect(client.calls[0].event).toBe("cogni.test.buffered");
    });
  });

  describe("capture", () => {
    it("should capture event with required fields", () => {
      const client = createMockClient();
      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc123",
        environment: "test",
        client,
      });

      capture({
        event: "cogni.auth.signed_in",
        identity: {
          userId: "user-uuid-123",
          sessionId: "session-uuid-456",
          tenantId: "tenant-1",
          traceId: "abcdef1234567890abcdef1234567890",
        },
        properties: {
          provider: "github",
        },
      });

      expect(client.calls).toHaveLength(1);
      const call = client.calls[0];
      expect(call.distinctId).toBe("user-uuid-123");
      expect(call.event).toBe("cogni.auth.signed_in");
      expect(call.properties).toMatchObject({
        session_id: "session-uuid-456",
        tenant_id: "tenant-1",
        trace_id: "abcdef1234567890abcdef1234567890",
        environment: "test",
        app_version: "abc123",
        provider: "github",
      });
      expect(call.timestamp).toBeInstanceOf(Date);
    });

    it("should include environment and app_version defaults", () => {
      const client = createMockClient();
      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "sha-abc123",
        environment: "staging",
        client,
      });

      capture({
        event: "cogni.test.defaults",
        identity: {
          userId: "user-1",
          sessionId: "session-1",
        },
      });

      const props = client.calls[0].properties;
      expect(props).toMatchObject({
        environment: "staging",
        app_version: "sha-abc123",
      });
    });

    it("should omit tenantId and traceId when null/undefined", () => {
      const client = createMockClient();
      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc",
        environment: "test",
        client,
      });

      capture({
        event: "cogni.test.no_optional",
        identity: {
          userId: "user-1",
          sessionId: "session-1",
          tenantId: null,
          traceId: undefined,
        },
      });

      const props = client.calls[0].properties as Record<string, unknown>;
      expect(props).not.toHaveProperty("tenant_id");
      expect(props).not.toHaveProperty("trace_id");
    });

    it("should reject event with missing event name", () => {
      const client = createMockClient();
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc",
        environment: "test",
        client,
      });

      capture({
        event: "",
        identity: { userId: "user-1", sessionId: "session-1" },
      });

      expect(client.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("missing or invalid event name"),
        expect.anything()
      );

      warnSpy.mockRestore();
    });

    it("should reject event with missing userId", () => {
      const client = createMockClient();
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc",
        environment: "test",
        client,
      });

      capture({
        event: "cogni.test.event",
        identity: { userId: "", sessionId: "session-1" },
      });

      expect(client.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("missing userId"),
        expect.anything()
      );

      warnSpy.mockRestore();
    });

    it("should reject event with missing sessionId", () => {
      const client = createMockClient();
      const warnSpy = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);

      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc",
        environment: "test",
        client,
      });

      capture({
        event: "cogni.test.event",
        identity: { userId: "user-1", sessionId: "" },
      });

      expect(client.calls).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("missing sessionId"),
        expect.anything()
      );

      warnSpy.mockRestore();
    });
  });

  describe("buffer", () => {
    it("should buffer events before initialization", () => {
      capture({
        event: "cogni.test.pre_init",
        identity: { userId: "user-1", sessionId: "session-1" },
      });

      const buffer = getBuffer();
      expect(buffer).toHaveLength(1);
      expect(buffer[0].event).toBe("cogni.test.pre_init");
      expect(buffer[0].distinctId).toBe("user-1");
    });

    it("should cap buffer at MAX_BUFFER_SIZE", () => {
      for (let i = 0; i < 1100; i++) {
        capture({
          event: "cogni.test.flood",
          identity: { userId: "user-1", sessionId: "session-1" },
        });
      }

      // Buffer should be capped at 1000
      expect(getBuffer().length).toBeLessThanOrEqual(1000);
    });
  });

  describe("shutdownAnalytics", () => {
    it("should call shutdown on client", async () => {
      const client = createMockClient();
      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc",
        environment: "test",
        client,
      });

      await shutdownAnalytics();
      expect(client.shutdownCalled).toBe(true);
      expect(isAnalyticsInitialized()).toBe(false);
    });

    it("should be safe to call when not initialized", async () => {
      // Should not throw
      await shutdownAnalytics();
    });
  });

  describe("event properties typing", () => {
    it("should accept typed properties", () => {
      const client = createMockClient();
      initAnalytics({
        apiKey: "test-key",
        host: "http://localhost:8000",
        appVersion: "abc",
        environment: "test",
        client,
      });

      capture({
        event: "cogni.agent.run_completed",
        identity: { userId: "user-1", sessionId: "session-1" },
        properties: {
          run_id: "run-123",
          success: true,
          latency_ms: 1500,
          model: "gpt-4o",
          cost_usd: 0.05,
          tokens_in: 1000,
          tokens_out: 500,
        },
      });

      const props = client.calls[0].properties as Record<string, unknown>;
      expect(props.run_id).toBe("run-123");
      expect(props.success).toBe(true);
      expect(props.latency_ms).toBe(1500);
      expect(props.model).toBe("gpt-4o");
      expect(props.cost_usd).toBe(0.05);
    });
  });
});
