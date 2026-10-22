// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/capability`
 * Purpose: Unit coverage for the createKnowledgeCapability factory — proves the v0 gate chain runs on every write before reaching the port, and that valid writes are upserted + committed.
 * Scope: Pure tests with a hand-rolled stub port; only exercises the write seam plus a sanity check on a read passthrough. Does not call Doltgres, HTTP, or any real adapter.
 * Invariants: GATES_FAIL_CLOSED, AUTO_COMMIT_ON_WRITE
 * Side-effects: none
 * Links: packages/knowledge-store/src/capability.ts, work/projects/proj.knowledge-syntropy.md
 * @internal
 */

import { describe, expect, it } from "vitest";

import { createKnowledgeCapability } from "../src/capability.js";
import { KnowledgeGateError } from "../src/domain/gates/index.js";
import type {
  Knowledge,
  NewCitation,
  NewKnowledge,
} from "../src/domain/schemas.js";
import type {
  KnowledgeStorePort,
  KnowledgeWriteSession,
} from "../src/port/knowledge-store.port.js";

function stubKnowledge(entry: NewKnowledge): Knowledge {
  return {
    id: entry.id,
    domain: entry.domain,
    entityId: entry.entityId ?? null,
    title: entry.title,
    content: entry.content,
    entryType: entry.entryType ?? "finding",
    status: entry.status ?? "draft",
    confidencePct: entry.confidencePct ?? 30,
    sourceType: entry.sourceType,
    sourceRef: entry.sourceRef ?? null,
    sourceNode: entry.sourceNode ?? null,
    tags: entry.tags ?? null,
    createdAt: "2026-05-27T00:00:00.000Z",
    updatedAt: "2026-05-27T00:00:00.000Z",
  };
}

function makeStubPort(rejectCitation = false) {
  const calls: {
    upsert: NewKnowledge[];
    commits: string[];
    citations: NewCitation[];
    order: string[];
  } = {
    upsert: [],
    commits: [],
    citations: [],
    order: [],
  };
  let open = false;
  const port = {
    withWrite: async <T>(
      input: { message: string },
      run: (write: KnowledgeWriteSession) => Promise<T>
    ): Promise<T> => {
      expect(open).toBe(false);
      calls.order.push("scope");
      open = true;
      const before = {
        upsert: calls.upsert.length,
        citations: calls.citations.length,
      };
      try {
        const value = await run(port as unknown as KnowledgeWriteSession);
        calls.commits.push(input.message);
        calls.order.push("commit");
        return value;
      } catch (error) {
        calls.upsert.length = before.upsert;
        calls.citations.length = before.citations;
        calls.order.push("rollback");
        throw error;
      } finally {
        open = false;
        calls.order.push("close");
      }
    },
    getKnowledge: async () => {
      expect(open).toBe(true);
      return null;
    },
    upsertKnowledge: async (entry: NewKnowledge): Promise<Knowledge> => {
      expect(open).toBe(true);
      calls.order.push("upsert");
      calls.upsert.push(entry);
      return stubKnowledge(entry);
    },
    addCitation: async (edge: NewCitation) => {
      expect(open).toBe(true);
      calls.order.push("citation");
      calls.citations.push(edge);
      if (rejectCitation) throw new Error("citation rejected");
      return { id: "stub-edge", ...edge };
    },
    commit: async (message: string): Promise<string> => {
      expect(open).toBe(true);
      calls.commits.push(message);
      return "stub-hash";
    },
    // Other methods present only to satisfy the interface; unused in these tests.
  } as unknown as KnowledgeStorePort;
  return { port, calls };
}

describe("createKnowledgeCapability — write path with v0 gates", () => {
  it("rejects a write with an invalid slug and never touches the port", async () => {
    const { port, calls } = makeStubPort();
    const cap = createKnowledgeCapability(port);

    await expect(
      cap.write({
        id: "BAD--double-dash",
        domain: "meta",
        title: "Bad slug should be rejected",
        content: "x",
        sourceType: "external",
        sourceRef: "https://example.com",
      })
    ).rejects.toBeInstanceOf(KnowledgeGateError);

    expect(calls.upsert).toHaveLength(0);
    expect(calls.order).toEqual([]);
    expect(calls.commits).toHaveLength(0);
  });

  it("rejects a write missing source_ref for source_type=external", async () => {
    const { port, calls } = makeStubPort();
    const cap = createKnowledgeCapability(port);

    await expect(
      cap.write({
        id: "valid-slug",
        domain: "meta",
        title: "Valid title",
        content: "x",
        sourceType: "external",
      })
    ).rejects.toBeInstanceOf(KnowledgeGateError);

    expect(calls.upsert).toHaveLength(0);
    expect(calls.order).toEqual([]);
  });

  it("upserts + commits a valid write through to the port", async () => {
    const { port, calls } = makeStubPort();
    const cap = createKnowledgeCapability(port);

    const entry = await cap.write({
      id: "fed-rate-base-rate",
      domain: "prediction-market",
      title: "Fed rate base rate is 35% in election years",
      content: "Historical frequency since 1980.",
      sourceType: "external",
      sourceRef: "https://bls.gov/...",
    });

    expect(entry.id).toBe("fed-rate-base-rate");
    expect(calls.upsert).toHaveLength(1);
    expect(calls.upsert[0]?.id).toBe("fed-rate-base-rate");
    expect(calls.commits).toHaveLength(1);
    expect(calls.commits[0]).toContain("Fed rate base rate");
    expect(calls.order).toEqual(["scope", "upsert", "commit", "close"]);
  });

  it("writes outgoing citation edges before the commit (compounding write)", async () => {
    const { port, calls } = makeStubPort();
    const cap = createKnowledgeCapability(port);

    await cap.write({
      id: "oss-cap-eval-harness",
      domain: "oss-ai",
      title: "Eval harness comparison",
      content: "promptfoo vs deepeval",
      sourceType: "external",
      sourceRef: "https://example.com",
      citations: [
        { citedId: "oss-promptfoo", citationType: "supports" },
        { citedId: "oss-deepeval", citationType: "supports" },
      ],
    });

    expect(calls.order).toEqual([
      "scope",
      "upsert",
      "citation",
      "citation",
      "commit",
      "close",
    ]);
    expect(calls.citations).toHaveLength(2);
    expect(calls.citations[0]).toMatchObject({
      citingId: "oss-cap-eval-harness",
      citedId: "oss-promptfoo",
      citationType: "supports",
    });
    expect(calls.commits).toHaveLength(1);
  });

  it("rolls back one logical write when a citation fails, with no commit", async () => {
    const { port, calls } = makeStubPort(true);
    const cap = createKnowledgeCapability(port);
    await expect(
      cap.write({
        id: "valid-slug",
        domain: "meta",
        title: "Valid write",
        content: "body",
        sourceType: "agent",
        citations: [{ citedId: "missing", citationType: "supports" }],
      })
    ).rejects.toThrow("citation rejected");
    expect(calls.order).toEqual([
      "scope",
      "upsert",
      "citation",
      "rollback",
      "close",
    ]);
    expect(calls.upsert).toEqual([]);
    expect(calls.citations).toEqual([]);
    expect(calls.commits).toEqual([]);
  });

  it("honors the opt-out via empty gate set (test-mode escape hatch)", async () => {
    const { port, calls } = makeStubPort();
    const cap = createKnowledgeCapability(port, { gates: [] });

    // Slug that would normally fail the v0 shape gate — accepted because we
    // injected an empty gate set. Demonstrates the configurability seam used
    // by unit tests that need raw port access.
    await cap.write({
      id: "BAD--double-dash",
      domain: "meta",
      title: "Direct port test",
      content: "x",
      sourceType: "external",
      sourceRef: "https://example.com",
    });
    expect(calls.upsert).toHaveLength(1);
  });
});
