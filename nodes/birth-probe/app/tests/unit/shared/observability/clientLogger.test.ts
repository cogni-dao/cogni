// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/shared/observability/clientLogger`
 * Purpose: Verifies clientLogger environment gating (prod debug/info noop, warn/error always output), forbidden key dropping, truncation behavior, and safe serialization.
 * Scope: Covers env-based output control, key scrubbing (case-insensitive), string/array truncation, circular reference handling, and does NOT cover network telemetry.
 * Invariants: debug/info are noop in production; warn/error always output; forbidden keys dropped from meta; serialization never throws.
 * Side-effects: IO
 * Notes: Uses vi.stubEnv for environment control and mocked console methods. Circular reference handling delegated to fast-safe-stringify.
 * Links: src/shared/observability/clientLogger.ts
 * @public
 */

// Import from package path
import * as nodeShared from "@cogni/node-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientLogger = nodeShared.clientLogger;
const { EVENT_NAMES } = nodeShared;

describe("clientLogger", () => {
  // Store original console methods
  const originalConsole = { ...console };

  beforeEach(() => {
    // Mock console methods
    console.debug = vi.fn();
    console.info = vi.fn();
    console.warn = vi.fn();
    console.error = vi.fn();
  });

  afterEach(() => {
    // Restore console methods
    console.debug = originalConsole.debug;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;

    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe("debug()", () => {
    it("should be no-op in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      clientLogger.debug(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.debug).not.toHaveBeenCalled();
    });

    it("should output to console in development", () => {
      vi.stubEnv("NODE_ENV", "development");

      clientLogger.debug(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.debug).toHaveBeenCalledWith(
        "[CLIENT] DEBUG TEST_EVENT",
        '{"foo":"bar"}'
      );
    });

    it("should handle undefined meta", () => {
      vi.stubEnv("NODE_ENV", "development");

      clientLogger.debug(EVENT_NAMES.TEST_EVENT);

      expect(console.debug).toHaveBeenCalledWith(
        "[CLIENT] DEBUG TEST_EVENT",
        "{}"
      );
    });
  });

  describe("info()", () => {
    it("should be no-op in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      clientLogger.info(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.info).not.toHaveBeenCalled();
    });

    it("should output to console in development", () => {
      vi.stubEnv("NODE_ENV", "development");

      clientLogger.info(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.info).toHaveBeenCalledWith(
        "[CLIENT] INFO TEST_EVENT",
        '{"foo":"bar"}'
      );
    });
  });

  describe("warn()", () => {
    it("should output to console in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      clientLogger.warn(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.warn).toHaveBeenCalledWith(
        "[CLIENT] WARN TEST_EVENT",
        '{"foo":"bar"}'
      );
    });

    it("should output to console in development", () => {
      vi.stubEnv("NODE_ENV", "development");

      clientLogger.warn(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.warn).toHaveBeenCalledWith(
        "[CLIENT] WARN TEST_EVENT",
        '{"foo":"bar"}'
      );
    });
  });

  describe("error()", () => {
    it("should output to console in production", () => {
      vi.stubEnv("NODE_ENV", "production");

      clientLogger.error(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.error).toHaveBeenCalledWith(
        "[CLIENT] ERROR TEST_EVENT",
        '{"foo":"bar"}'
      );
    });

    it("should output to console in development", () => {
      vi.stubEnv("NODE_ENV", "development");

      clientLogger.error(EVENT_NAMES.TEST_EVENT, { foo: "bar" });

      expect(console.error).toHaveBeenCalledWith(
        "[CLIENT] ERROR TEST_EVENT",
        '{"foo":"bar"}'
      );
    });
  });

  describe("meta scrubbing", () => {
    it("should drop forbidden keys from metadata", () => {
      vi.stubEnv("NODE_ENV", "development");

      clientLogger.warn(EVENT_NAMES.TEST_EVENT, {
        apiKey: "secret-key-123",
        authorization: "Bearer token",
        prompt: "secret prompt",
        messages: ["msg1", "msg2"],
        safeField: "visible",
      });

      const call = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      if (!call) throw new Error("Expected console.warn to be called");
      const metaStr = call[1] as string;
      const parsed = JSON.parse(metaStr);

      // Forbidden keys should be dropped entirely
      expect(parsed.apiKey).toBeUndefined();
      expect(parsed.authorization).toBeUndefined();
      expect(parsed.prompt).toBeUndefined();
      expect(parsed.messages).toBeUndefined();
      expect(parsed.safeField).toBe("visible");
    });

    it("should drop forbidden keys case-insensitively", () => {
      vi.stubEnv("NODE_ENV", "development");

      clientLogger.warn(EVENT_NAMES.TEST_EVENT, {
        ApiKey: "secret-1",
        AUTHORIZATION: "secret-2",
        Prompt: "secret-3",
        MESSAGES: "secret-4",
        Cookie: "secret-5",
        "Set-Cookie": "secret-6",
        safeField: "visible",
      });

      const call = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      if (!call) throw new Error("Expected console.warn to be called");
      const metaStr = call[1] as string;
      const parsed = JSON.parse(metaStr);

      // All forbidden key variants should be dropped
      expect(parsed.ApiKey).toBeUndefined();
      expect(parsed.AUTHORIZATION).toBeUndefined();
      expect(parsed.Prompt).toBeUndefined();
      expect(parsed.MESSAGES).toBeUndefined();
      expect(parsed.Cookie).toBeUndefined();
      expect(parsed["Set-Cookie"]).toBeUndefined();
      expect(parsed.safeField).toBe("visible");
    });

    it("should truncate large strings", () => {
      vi.stubEnv("NODE_ENV", "development");

      const largeString = "x".repeat(3000);

      clientLogger.warn(EVENT_NAMES.TEST_EVENT, { large: largeString });

      const call = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      if (!call) throw new Error("Expected console.warn to be called");
      const metaStr = call[1] as string;
      const parsed = JSON.parse(metaStr);

      expect(parsed.large).toContain("[TRUNCATED]");
      expect(parsed.large.length).toBeLessThan(3000);
    });

    it("should truncate large arrays", () => {
      vi.stubEnv("NODE_ENV", "development");

      const largeArray = new Array(150).fill("item");

      clientLogger.warn(EVENT_NAMES.TEST_EVENT, { items: largeArray });

      const call = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      if (!call) throw new Error("Expected console.warn to be called");
      const metaStr = call[1] as string;
      const parsed = JSON.parse(metaStr);

      expect(parsed.items).toContain("[TRUNCATED]");
      expect(parsed.items.length).toBe(101); // 100 items + truncation marker
    });

    it("should handle circular references without throwing", () => {
      vi.stubEnv("NODE_ENV", "development");

      // Create circular reference
      const circular: Record<string, unknown> = { id: 123 };
      circular.self = circular;

      // Should not throw
      expect(() => {
        clientLogger.warn("TEST_EVENT", circular);
      }).not.toThrow();

      const call = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      if (!call) throw new Error("Expected console.warn to be called");
      const metaStr = call[1] as string;

      // Should produce valid stringified output (fast-safe-stringify handles circulars)
      expect(metaStr).toBeTruthy();
      expect(typeof metaStr).toBe("string");
      // fast-safe-stringify replaces circular refs with "[Circular]"
      expect(metaStr).toContain("[Circular]");
    });

    it("should handle objects with throwing getters and return SERIALIZATION_FAILED", () => {
      vi.stubEnv("NODE_ENV", "development");

      // Create object with getter that throws during Object.entries access
      const problematicObj = {
        normal: "value",
        get badGetter() {
          throw new Error("Getter throws during serialization");
        },
      };

      // Should not throw - catch block should catch it
      expect(() => {
        clientLogger.warn("TEST_EVENT", problematicObj);
      }).not.toThrow();

      const call = (console.warn as ReturnType<typeof vi.fn>).mock.calls[0];
      if (!call) throw new Error("Expected console.warn to be called");
      const metaStr = call[1] as string;

      // Should fail-closed with SERIALIZATION_FAILED marker
      expect(metaStr).toBe('"SERIALIZATION_FAILED"');
    });
  });
});
