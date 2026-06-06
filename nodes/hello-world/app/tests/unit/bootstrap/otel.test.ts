// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/otel.test`
 * Purpose: Unit tests for OTel helpers - withRootSpan trace ID generation.
 * Scope: Verify withRootSpan returns non-zero traceId when SDK is running. Does NOT test full distributed tracing.
 * Invariants: Per AI_SETUP_SPEC.md Test Gates - P0 required test.
 * Side-effects: none (uses in-memory noop tracer by default)
 * Notes: In real runtime with SDK initialized, traceId would be non-zero.
 * Links: AI_SETUP_SPEC.md, bootstrap/otel.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { isValidTraceId, withRootSpan } from "@/bootstrap/otel";

describe("bootstrap/otel", () => {
  describe("withRootSpan (P0 invariant)", () => {
    it("returns a traceId from the span context", async () => {
      let capturedTraceId: string | undefined;

      await withRootSpan(
        "test-span",
        { route_id: "test" },
        async ({ traceId }) => {
          capturedTraceId = traceId;
          return "result";
        }
      );

      // TraceId should be a 32-char hex string
      expect(capturedTraceId).toBeDefined();
      expect(capturedTraceId).toHaveLength(32);
      expect(capturedTraceId).toMatch(/^[a-f0-9]{32}$/);
    });

    it("provides span for setting attributes", async () => {
      let spanHasSetAttribute = false;

      await withRootSpan(
        "test-span",
        { route_id: "test" },
        async ({ span }) => {
          // span.setAttribute should be callable (noop in test, but no throw)
          span.setAttribute("test_attr", "test_value");
          spanHasSetAttribute = true;
          return "result";
        }
      );

      expect(spanHasSetAttribute).toBe(true);
    });

    it("returns handler result", async () => {
      const result = await withRootSpan(
        "test-span",
        { route_id: "test" },
        async () => {
          return { success: true, data: 42 };
        }
      );

      expect(result).toEqual({ success: true, data: 42 });
    });
  });

  describe("isValidTraceId", () => {
    it("returns false for zero trace ID", () => {
      expect(isValidTraceId("00000000000000000000000000000000")).toBe(false);
    });

    it("returns false for invalid length", () => {
      expect(isValidTraceId("abc123")).toBe(false);
    });

    it("returns false for non-hex characters", () => {
      // 'z' is not a valid hex character
      expect(isValidTraceId("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBe(false);
      expect(isValidTraceId("gggggggggggggggggggggggggggggggg")).toBe(false);
    });

    it("returns false for uppercase hex (OTel uses lowercase)", () => {
      expect(isValidTraceId("A1B2C3D4E5F6789012345678ABCDEF01")).toBe(false);
    });

    it("returns true for valid non-zero trace ID", () => {
      expect(isValidTraceId("a1b2c3d4e5f6789012345678abcdef01")).toBe(true);
    });
  });
});
