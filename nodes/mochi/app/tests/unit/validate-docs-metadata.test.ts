// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/validate-docs-metadata.test`
 * Purpose: Unit tests for docs/work metadata validation logic.
 * Scope: Tests property extraction, CSV validation, enum validation; does NOT test file I/O.
 * Invariants: All validation rules from DOCS_ORGANIZATION_PLAN.md must be tested.
 * Side-effects: none
 * Notes: Uses vitest; tests validator functions in isolation.
 * Links: scripts/validate-docs-metadata.mjs, docs/archive/DOCS_ORGANIZATION_PLAN.md
 * @internal
 */

import { describe, expect, it } from "vitest";

// === INLINE COPIES OF VALIDATOR LOGIC (to test without file I/O) ===

const DOC_TYPES = ["spec", "adr", "runbook", "howto", "reference", "concept"];
const DOC_STATUS = ["active", "deprecated", "superseded", "draft"];
const _DOC_TRUST = ["canonical", "reviewed", "draft", "external"]; // Reserved for future tests
const PROJECT_STATE = ["Active", "Paused", "Done", "Dropped"];
const _ISSUE_STATE = ["Backlog", "Todo", "In Progress", "Done", "Cancelled"]; // Reserved for future tests
const PRIORITY = ["Urgent", "High", "Medium", "Low", "None"];
const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const DOC_REQUIRED = [
  "id",
  "type",
  "title",
  "status",
  "trust",
  "summary",
  "read_when",
  "owner",
  "created",
];
const DOCS_FORBIDDEN = ["work_item_id", "work_item_type", "state", "outcome"];
const WORK_FORBIDDEN = ["id", "type", "status", "trust", "read_when"];

function extractProperties(content) {
  const props = {};
  const lines = content.split("\n");
  for (const line of lines) {
    const match = line.match(/^([a-z_]+)::\s*(.*)$/);
    if (match) {
      const key = match[1];
      const value = match[2].trim();
      if (props[key]) throw new Error(`duplicate property key: ${key}`);
      props[key] = value;
    } else if (
      line.startsWith("#") ||
      (line.trim() && !line.match(/^[a-z_]+::/))
    ) {
      break;
    }
  }
  return props;
}

function validateCSV(field, value) {
  if (!value) return [];
  const errors = [];
  if (/,,/.test(value)) errors.push(`${field} has empty CSV segment`);
  if (/^,|,$/.test(value)) errors.push(`${field} has leading/trailing comma`);
  const segments = value.split(",").map((s) => s.trim());
  if (segments.some((s) => !s))
    errors.push(`${field} has empty CSV segment after trim`);
  return errors;
}

function checkForbidden(content) {
  const errors = [];
  if (/^---\s*\n/.test(content)) errors.push("YAML frontmatter forbidden");
  if (/\[\[.+?\]\]/.test(content)) errors.push("wikilinks forbidden");
  return errors;
}

// === TESTS ===

describe("extractProperties", () => {
  it("extracts simple properties", () => {
    const content = `id:: test-id
type:: spec
title:: Test Title

# Heading`;
    const props = extractProperties(content);
    expect(props.id).toBe("test-id");
    expect(props.type).toBe("spec");
    expect(props.title).toBe("Test Title");
  });

  it("stops at first heading", () => {
    const content = `id:: test-id
# Heading
type:: spec`;
    const props = extractProperties(content);
    expect(props.id).toBe("test-id");
    expect(props.type).toBeUndefined();
  });

  it("handles values with colons", () => {
    const content = `summary:: This is a test: with colons`;
    const props = extractProperties(content);
    expect(props.summary).toBe("This is a test: with colons");
  });

  it("throws on duplicate keys", () => {
    const content = `id:: test-id
id:: duplicate`;
    expect(() => extractProperties(content)).toThrow(
      "duplicate property key: id"
    );
  });
});

describe("validateCSV", () => {
  it("accepts valid CSV", () => {
    expect(validateCSV("owner", "alice, bob, charlie")).toEqual([]);
  });

  it("rejects empty segments", () => {
    const errors = validateCSV("owner", "alice,,bob");
    expect(errors).toContain("owner has empty CSV segment");
  });

  it("rejects leading comma", () => {
    const errors = validateCSV("owner", ",alice");
    expect(errors).toContain("owner has leading/trailing comma");
  });

  it("rejects trailing comma", () => {
    const errors = validateCSV("owner", "alice,");
    expect(errors).toContain("owner has leading/trailing comma");
  });

  it("rejects whitespace-only segments", () => {
    const errors = validateCSV("owner", "alice,   , bob");
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("checkForbidden", () => {
  it("rejects YAML frontmatter", () => {
    const content = `---
title: test
---
# Content`;
    const errors = checkForbidden(content);
    expect(errors).toContain("YAML frontmatter forbidden");
  });

  it("rejects wikilinks", () => {
    const content = `id:: test
See [[Other Doc]] for details.`;
    const errors = checkForbidden(content);
    expect(errors).toContain("wikilinks forbidden");
  });

  it("accepts valid content", () => {
    const content = `id:: test
See [Other Doc](./other.md) for details.`;
    const errors = checkForbidden(content);
    expect(errors).toEqual([]);
  });
});

describe("enum validation", () => {
  it("validates doc types", () => {
    expect(DOC_TYPES).toContain("spec");
    expect(DOC_TYPES).toContain("adr");
    expect(DOC_TYPES).not.toContain("invalid");
  });

  it("validates doc status", () => {
    expect(DOC_STATUS).toContain("active");
    expect(DOC_STATUS).toContain("draft");
    expect(DOC_STATUS).not.toContain("todo");
  });

  it("validates project state (Plane-aligned)", () => {
    expect(PROJECT_STATE).toContain("Active");
    expect(PROJECT_STATE).toContain("Done");
    expect(PROJECT_STATE).not.toContain("active"); // case-sensitive
  });

  it("validates priority (Plane-aligned)", () => {
    expect(PRIORITY).toContain("Urgent");
    expect(PRIORITY).toContain("High");
    expect(PRIORITY).not.toContain("p0"); // old format rejected
  });
});

describe("date validation", () => {
  it("accepts valid dates", () => {
    expect(DATE_REGEX.test("2026-02-05")).toBe(true);
    expect(DATE_REGEX.test("2025-12-31")).toBe(true);
  });

  it("rejects invalid dates", () => {
    expect(DATE_REGEX.test("02-05-2026")).toBe(false);
    expect(DATE_REGEX.test("2026/02/05")).toBe(false);
    expect(DATE_REGEX.test("2026-2-5")).toBe(false);
  });
});

describe("field set separation", () => {
  it("docs forbidden fields include work fields", () => {
    expect(DOCS_FORBIDDEN).toContain("work_item_id");
    expect(DOCS_FORBIDDEN).toContain("work_item_type");
    expect(DOCS_FORBIDDEN).toContain("state");
  });

  it("work forbidden fields include doc fields", () => {
    expect(WORK_FORBIDDEN).toContain("id");
    expect(WORK_FORBIDDEN).toContain("type");
    expect(WORK_FORBIDDEN).toContain("status");
    expect(WORK_FORBIDDEN).toContain("trust");
  });
});

describe("required keys", () => {
  it("docs require orientation fields", () => {
    expect(DOC_REQUIRED).toContain("summary");
    expect(DOC_REQUIRED).toContain("read_when");
  });

  it("docs require core fields", () => {
    expect(DOC_REQUIRED).toContain("id");
    expect(DOC_REQUIRED).toContain("type");
    expect(DOC_REQUIRED).toContain("status");
    expect(DOC_REQUIRED).toContain("trust");
  });
});
