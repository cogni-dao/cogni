// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: tests/unit/app/knowledge/obsidian-vault
 * Purpose: Unit tests for the pure Obsidian vault serializer.
 * Scope: Pure function testing — file layout, frontmatter, wikilinks, determinism. No I/O.
 * Invariants: DETERMINISTIC, LINK_BY_UNIQUE_NOTE_NAME, PROVENANCE_IN_FRONTMATTER.
 * Side-effects: none
 * Links: src/app/api/v1/knowledge/export/_lib/obsidian-vault.ts
 * @public
 */

import type { Citation, Domain, Knowledge } from "@cogni/knowledge-store";
import { describe, expect, it } from "vitest";
import {
  buildObsidianVault,
  type VaultInput,
} from "@/app/api/v1/knowledge/export/_lib/obsidian-vault";

function domain(id: string, description: string | null = null): Domain {
  return {
    id,
    name: id,
    description,
    confidencePct: 40,
    entryCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function entry(over: Partial<Knowledge> & Pick<Knowledge, "id" | "title">): {
  entry: Knowledge;
  citations: Citation[];
} {
  return {
    entry: {
      domain: "meta",
      content: "body",
      sourceType: "agent",
      ...over,
    } as Knowledge,
    citations: [],
  };
}

function find(files: ReturnType<typeof buildObsidianVault>, path: string) {
  return files.find((f) => f.path === path);
}

describe("buildObsidianVault", () => {
  it("emits a README plus one note per entry, foldered by domain", () => {
    const input: VaultInput = {
      domains: [domain("meta", "Meta domain")],
      entries: [
        entry({ id: "k.1", title: "First Finding", domain: "meta" }),
        entry({ id: "k.2", title: "Second Finding", domain: "meta" }),
      ],
    };
    const files = buildObsidianVault(input);
    expect(find(files, "README.md")).toBeDefined();
    expect(find(files, "meta/first-finding.md")).toBeDefined();
    expect(find(files, "meta/second-finding.md")).toBeDefined();
    expect(files).toHaveLength(3);
  });

  it("puts provenance in frontmatter with an id alias", () => {
    const files = buildObsidianVault({
      domains: [domain("meta")],
      entries: [
        entry({
          id: "k.42",
          title: "Aliased",
          domain: "meta",
          entryType: "rule",
          confidencePct: 80,
          sourceType: "human",
          sourceRef: "https://example.com",
          tags: ["a", "b"],
        }),
      ],
    });
    const note = find(files, "meta/aliased.md");
    expect(note).toBeDefined();
    const c = note?.content ?? "";
    expect(c).toContain('id: "k.42"');
    expect(c).toContain('aliases: ["k.42"]');
    expect(c).toContain('domain: "meta"');
    expect(c).toContain('entry_type: "rule"');
    expect(c).toContain("confidence_pct: 80");
    expect(c).toContain('source_type: "human"');
    expect(c).toContain('tags: ["a", "b"]');
    expect(c).toContain("# Aliased");
  });

  it("renders citations as wikilinks to the cited note name", () => {
    const cited = entry({
      id: "k.target",
      title: "Target Note",
      domain: "meta",
    });
    const citing = entry({ id: "k.src", title: "Source Note", domain: "meta" });
    citing.citations = [
      {
        id: "c.1",
        citingId: "k.src",
        citedId: "k.target",
        citationType: "supports",
        context: "because reasons",
      },
    ];
    const files = buildObsidianVault({
      domains: [domain("meta")],
      entries: [cited, citing],
    });
    const note = find(files, "meta/source-note.md");
    expect(note?.content).toContain("## Citations");
    expect(note?.content).toContain(
      "- **supports** → [[target-note]] — because reasons"
    );
  });

  it("falls back to the raw id for citations outside export scope", () => {
    const citing = entry({ id: "k.src", title: "Orphan", domain: "meta" });
    citing.citations = [
      {
        id: "c.9",
        citingId: "k.src",
        citedId: "k.missing",
        citationType: "extends",
      },
    ];
    const files = buildObsidianVault({
      domains: [domain("meta")],
      entries: [citing],
    });
    expect(find(files, "meta/orphan.md")?.content).toContain(
      "- **extends** → [[k.missing]]"
    );
  });

  it("disambiguates colliding titles into unique note names", () => {
    const files = buildObsidianVault({
      domains: [domain("meta")],
      entries: [
        entry({ id: "k.a", title: "Same Title", domain: "meta" }),
        entry({ id: "k.b", title: "Same Title", domain: "meta" }),
      ],
    });
    const notes = files.map((f) => f.path).filter((p) => p.startsWith("meta/"));
    expect(new Set(notes).size).toBe(notes.length);
    expect(notes).toContain("meta/same-title.md");
  });

  it("is deterministic regardless of input ordering", () => {
    const a = entry({ id: "k.1", title: "Alpha", domain: "meta" });
    const b = entry({ id: "k.2", title: "Beta", domain: "meta" });
    const forward = buildObsidianVault({
      domains: [domain("meta")],
      entries: [a, b],
    });
    const reversed = buildObsidianVault({
      domains: [domain("meta")],
      entries: [b, a],
    });
    expect(forward).toEqual(reversed);
  });
});
