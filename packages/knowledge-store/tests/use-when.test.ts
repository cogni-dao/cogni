// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/use-when`
 * Purpose: Unit coverage for the `useWhen` retrieval-trigger column — proves it round-trips through the fake adapter on insert and update, is accepted by the contribution input schema, is bounded, and is control-char sanitized like the other free-text fields.
 * Scope: Pure tests against the in-memory fake adapter and the Zod input schema. Does not touch Doltgres.
 * Invariants: PRESERVE_MARKDOWN_WHITESPACE (strip control chars, keep newlines/tabs)
 * Side-effects: none
 * Links: packages/knowledge-base/src/schema.ts, packages/knowledge-store/src/domain/contribution-schemas.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import { KnowledgeContributionEditSchema } from "../src/domain/contribution-schemas.js";

function newAdapter(): FakeKnowledgeStoreAdapter {
  const a = new FakeKnowledgeStoreAdapter();
  a.registerDomain({ id: "method", name: "Method" });
  return a;
}

const base = {
  id: "shelf-one-axis",
  domain: "method",
  title: "A shelf sorts on one axis or regrows a catch-all",
  content: "Body.",
  sourceType: "agent" as const,
};

describe("useWhen column", () => {
  it("round-trips on insert", async () => {
    const a = newAdapter();
    await a.addKnowledge({
      ...base,
      useWhen: "designing or reviewing a knowledge domain set",
    });
    const got = await a.getKnowledge(base.id);
    expect(got?.useWhen).toBe("designing or reviewing a knowledge domain set");
  });

  it("defaults to null when omitted, so existing rows stay valid", async () => {
    const a = newAdapter();
    await a.addKnowledge(base);
    const got = await a.getKnowledge(base.id);
    expect(got?.useWhen).toBeNull();
  });

  it("is independently updatable without touching content", async () => {
    const a = newAdapter();
    await a.addKnowledge({ ...base, useWhen: "first" });
    await a.updateKnowledge(base.id, { useWhen: "second" });
    const got = await a.getKnowledge(base.id);
    expect(got?.useWhen).toBe("second");
    expect(got?.content).toBe("Body.");
  });

  it("strips dangerous control chars but preserves ordinary text", async () => {
    const a = newAdapter();
    await a.addKnowledge({
      ...base,
      useWhen: `diagnosing${String.fromCharCode(7)} a 502`,
    });
    const got = await a.getKnowledge(base.id);
    expect(got?.useWhen).toBe("diagnosing a 502");
  });

  it("is accepted by the contribution edit schema", () => {
    const parsed = KnowledgeContributionEditSchema.safeParse({
      op: "insert",
      entry: { ...base, useWhen: "routing a question to a shelf" },
    });
    expect(parsed.success).toBe(true);
  });

  it("is bounded so it cannot become a second content field", () => {
    const parsed = KnowledgeContributionEditSchema.safeParse({
      op: "insert",
      entry: { ...base, useWhen: "x".repeat(321) },
    });
    expect(parsed.success).toBe(false);
  });
});
