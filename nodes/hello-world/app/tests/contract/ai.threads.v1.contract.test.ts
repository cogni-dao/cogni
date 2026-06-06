// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/ai.threads.v1.contract`
 * Purpose: Validates ai.threads.v1 contract schemas for list, load, and delete operations.
 * Scope: Tests Zod schema compliance for input/output shapes. Does not test route handlers or adapters.
 * Invariants: Schema must correctly validate/reject input structures per field constraints.
 * Side-effects: none
 * Links: @/contracts/ai.threads.v1.contract
 * @internal
 */

import {
  deleteThreadOperation,
  listThreadsOperation,
  loadThreadOperation,
} from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("ai.threads.v1 contract validation", () => {
  // ─────────────────────────────────────────────
  // List threads
  // ─────────────────────────────────────────────
  describe("listThreadsOperation", () => {
    describe("input", () => {
      it("accepts empty input (uses defaults)", () => {
        const result = listThreadsOperation.input.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.limit).toBe(50);
          expect(result.data.offset).toBe(0);
        }
      });

      it("accepts explicit limit and offset", () => {
        const result = listThreadsOperation.input.safeParse({
          limit: 10,
          offset: 20,
        });
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.limit).toBe(10);
          expect(result.data.offset).toBe(20);
        }
      });

      it("accepts limit at max boundary (100)", () => {
        const result = listThreadsOperation.input.safeParse({ limit: 100 });
        expect(result.success).toBe(true);
      });

      it("rejects limit exceeding 100", () => {
        const result = listThreadsOperation.input.safeParse({ limit: 101 });
        expect(result.success).toBe(false);
      });

      it("rejects limit of 0", () => {
        const result = listThreadsOperation.input.safeParse({ limit: 0 });
        expect(result.success).toBe(false);
      });

      it("rejects negative offset", () => {
        const result = listThreadsOperation.input.safeParse({ offset: -1 });
        expect(result.success).toBe(false);
      });
    });

    describe("output", () => {
      it("accepts valid thread list", () => {
        const result = listThreadsOperation.output.safeParse({
          threads: [
            {
              stateKey: "abc123",
              title: "My conversation",
              updatedAt: "2026-02-13T10:00:00.000Z",
              messageCount: 5,
            },
          ],
        });
        expect(result.success).toBe(true);
      });

      it("accepts empty thread list", () => {
        const result = listThreadsOperation.output.safeParse({ threads: [] });
        expect(result.success).toBe(true);
      });

      it("accepts thread with metadata", () => {
        const result = listThreadsOperation.output.safeParse({
          threads: [
            {
              stateKey: "key-1",
              updatedAt: "2026-02-13T10:00:00.000Z",
              messageCount: 0,
              metadata: { model: "gpt-4", graphName: "chat" },
            },
          ],
        });
        expect(result.success).toBe(true);
      });

      it("accepts thread without optional title", () => {
        const result = listThreadsOperation.output.safeParse({
          threads: [
            {
              stateKey: "key-1",
              updatedAt: "2026-02-13T10:00:00.000Z",
              messageCount: 2,
            },
          ],
        });
        expect(result.success).toBe(true);
      });

      it("rejects negative messageCount", () => {
        const result = listThreadsOperation.output.safeParse({
          threads: [
            {
              stateKey: "key-1",
              updatedAt: "2026-02-13T10:00:00.000Z",
              messageCount: -1,
            },
          ],
        });
        expect(result.success).toBe(false);
      });

      it("rejects non-datetime updatedAt", () => {
        const result = listThreadsOperation.output.safeParse({
          threads: [
            {
              stateKey: "key-1",
              updatedAt: "not-a-date",
              messageCount: 0,
            },
          ],
        });
        expect(result.success).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Load thread
  // ─────────────────────────────────────────────
  describe("loadThreadOperation", () => {
    describe("input", () => {
      it("accepts valid stateKey", () => {
        const result = loadThreadOperation.input.safeParse({
          stateKey: "abc123_XYZ-456",
        });
        expect(result.success).toBe(true);
      });

      it("rejects empty stateKey", () => {
        const result = loadThreadOperation.input.safeParse({ stateKey: "" });
        expect(result.success).toBe(false);
      });

      it("rejects stateKey with unsafe characters", () => {
        const result = loadThreadOperation.input.safeParse({
          stateKey: "key with spaces!",
        });
        expect(result.success).toBe(false);
        if (!result.success) {
          expect(result.error.issues[0]?.message).toContain("safe characters");
        }
      });

      it("rejects stateKey exceeding 128 chars", () => {
        const result = loadThreadOperation.input.safeParse({
          stateKey: "x".repeat(129),
        });
        expect(result.success).toBe(false);
      });

      it("accepts stateKey at max boundary (128 chars)", () => {
        const result = loadThreadOperation.input.safeParse({
          stateKey: "x".repeat(128),
        });
        expect(result.success).toBe(true);
      });
    });

    describe("output", () => {
      it("accepts valid load response with messages", () => {
        const result = loadThreadOperation.output.safeParse({
          stateKey: "abc123",
          messages: [
            { id: "1", role: "user", parts: [{ type: "text", text: "hi" }] },
          ],
        });
        expect(result.success).toBe(true);
      });

      it("accepts empty messages array (new thread)", () => {
        const result = loadThreadOperation.output.safeParse({
          stateKey: "abc123",
          messages: [],
        });
        expect(result.success).toBe(true);
      });

      it("rejects missing stateKey in output", () => {
        const result = loadThreadOperation.output.safeParse({
          messages: [],
        });
        expect(result.success).toBe(false);
      });
    });
  });

  // ─────────────────────────────────────────────
  // Delete thread
  // ─────────────────────────────────────────────
  describe("deleteThreadOperation", () => {
    describe("input", () => {
      it("accepts valid stateKey", () => {
        const result = deleteThreadOperation.input.safeParse({
          stateKey: "thread-to-delete",
        });
        expect(result.success).toBe(true);
      });

      it("rejects stateKey with unsafe characters", () => {
        const result = deleteThreadOperation.input.safeParse({
          stateKey: "../traversal",
        });
        expect(result.success).toBe(false);
      });
    });

    describe("output", () => {
      it("accepts { ok: true }", () => {
        const result = deleteThreadOperation.output.safeParse({ ok: true });
        expect(result.success).toBe(true);
      });

      it("rejects { ok: false }", () => {
        const result = deleteThreadOperation.output.safeParse({ ok: false });
        expect(result.success).toBe(false);
      });
    });
  });
});
