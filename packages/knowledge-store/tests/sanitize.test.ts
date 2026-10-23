// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/sanitize`
 * Purpose: Prove the write-boundary control-char sanitiser strips the bytes that break naive consumers of the knowledge recall list (bug.5062) while preserving markdown whitespace.
 * Scope: Pure unit test of stripDangerousControlChars plus a FakeKnowledgeStoreAdapter write→read round-trip. Does not touch a real database, HTTP, or the Doltgres adapter.
 * Invariants: PRESERVE_MARKDOWN_WHITESPACE.
 * Side-effects: none
 * Links: packages/knowledge-store/src/domain/sanitize.ts, bug.5062
 */

import { describe, expect, it } from "vitest";

import { FakeKnowledgeStoreAdapter } from "../src/adapters/fake/index.js";
import { stripDangerousControlChars } from "../src/domain/sanitize.js";

// Build strings from char codes so this source file carries no literal control
// characters (which would themselves be invisible in diffs and break tooling).
const chr = (code: number): string => String.fromCharCode(code);

describe("stripDangerousControlChars", () => {
  it("preserves TAB, LF, and CR (PRESERVE_MARKDOWN_WHITESPACE)", () => {
    const markdown = `# Title${chr(0x0a)}${chr(0x0a)}- a${chr(0x09)}b${chr(0x0d)}${chr(0x0a)}end`;
    expect(stripDangerousControlChars(markdown)).toBe(markdown);
  });

  it("returns ordinary prose unchanged (fast-path identity)", () => {
    const s = "plain markdown with **bold**, emoji 🚀, and accents café";
    expect(stripDangerousControlChars(s)).toBe(s);
  });

  it("strips NUL and every other C0 control except TAB/LF/CR", () => {
    for (let code = 0x00; code <= 0x1f; code++) {
      if (code === 0x09 || code === 0x0a || code === 0x0d) continue;
      const input = `a${chr(code)}b`;
      expect(stripDangerousControlChars(input)).toBe("ab");
    }
  });

  it("strips DEL (U+007F)", () => {
    expect(stripDangerousControlChars(`a${chr(0x7f)}b`)).toBe("ab");
  });

  it("strips a raw form feed / vertical tab embedded mid-line", () => {
    const dirty = `line one${chr(0x0c)}line two${chr(0x0b)}line three`;
    expect(stripDangerousControlChars(dirty)).toBe(
      "line oneline twoline three"
    );
    // The result parses as valid JSON when embedded in a string, unlike the input.
    expect(() =>
      JSON.parse(`"${stripDangerousControlChars(dirty)}"`)
    ).not.toThrow();
  });

  it("keeps characters above the C0/DEL range (e.g. C1 bytes as code points)", () => {
    // U+0080 is a C1 control code point but not in the stripped set; higher
    // Unicode (accents, CJK, emoji) must always survive.
    const s = `é中${chr(0x80)}`;
    expect(stripDangerousControlChars(s)).toBe(s);
  });
});

describe("FakeKnowledgeStoreAdapter — sanitises free text on write (parity with Doltgres)", () => {
  const DOMAIN = "sanitize-test";

  async function bootstrap() {
    const store = new FakeKnowledgeStoreAdapter();
    await store.registerDomain({
      id: DOMAIN,
      name: "Sanitize Test",
      description: "Test domain",
    });
    return store;
  }

  it("strips control chars from content and title on addKnowledge, preserving newlines", async () => {
    const store = await bootstrap();
    const dirtyContent = `intro${chr(0x0a)}body${chr(0x01)}with${chr(0x0c)}junk`;
    const dirtyTitle = `Title${chr(0x07)} with bell`;

    await store.withWrite(
      { operationId: "fixture:sanitize:82", message: "addKnowledge fixture" },
      (write) =>
        write.addKnowledge({
          id: "k-dirty",
          domain: DOMAIN,
          title: dirtyTitle,
          content: dirtyContent,
          sourceType: "agent",
        })
    );

    const row = await store.getKnowledge("k-dirty");
    expect(row).not.toBeNull();
    expect(row?.content).toBe(`intro${chr(0x0a)}bodywithjunk`);
    expect(row?.title).toBe("Title with bell");
    // The whole stored row serialises to valid JSON with no raw control bytes.
    const json = JSON.stringify(row);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it("strips control chars on updateKnowledge", async () => {
    const store = await bootstrap();
    await store.withWrite(
      { operationId: "fixture:sanitize:101", message: "addKnowledge fixture" },
      (write) =>
        write.addKnowledge({
          id: "k-upd",
          domain: DOMAIN,
          title: "clean",
          content: "clean",
          sourceType: "agent",
        })
    );
    await store.withWrite(
      {
        operationId: "fixture:sanitize:108",
        message: "updateKnowledge fixture",
      },
      (write) =>
        write.updateKnowledge("k-upd", {
          content: `updated${chr(0x00)}content`,
        })
    );
    const row = await store.getKnowledge("k-upd");
    expect(row?.content).toBe("updatedcontent");
  });
});
