#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-docs-metadata`
 * Purpose: Validates Obsidian-style YAML frontmatter of the Markdown that remains under /docs (knowledge lives in hub atoms).
 * Scope: Enforces field requirements, enums, date format, and required H2 headings for the remaining docs/spec, docs/guides and docs/research files; does NOT validate prose content or cross-references.
 * Invariants: /docs uses id/type/status/trust; no wikilinks.
 * Side-effects: IO
 * Notes: Uses `yaml` package for proper YAML parsing. Exits with error code if validation fails.
 * Links: scripts/validate-agents-md.mjs
 * @public
 */

import { readFileSync } from "node:fs";
import fg from "fast-glob";
import { parse as parseYaml } from "yaml";

// === DOCS ENUMS ===
const DOC_TYPES = ["spec", "adr", "guide", "research", "postmortem"];
const DOC_STATUS = ["active", "deprecated", "superseded", "draft"];
const DOC_TRUST = ["canonical", "reviewed", "draft", "external"];
const ADR_DECISION = ["proposed", "accepted", "deprecated", "superseded"];

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// === REQUIRED H2 HEADINGS (per doc type) ===
// Spec headings gated on spec_state being present (exempts legacy specs and indexes)
const SPEC_REQUIRED_HEADINGS = ["Design", "Goal", "Non-Goals"];
const ADR_REQUIRED_HEADINGS = ["Decision", "Rationale", "Consequences"];
const POSTMORTEM_REQUIRED_HEADINGS = ["Summary", "Timeline"];

// === REQUIRED KEYS ===
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

// === FORBIDDEN FIELDS ===
const DOCS_FORBIDDEN = ["outcome"];

// === YAML FRONTMATTER PARSER ===
function extractFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) {
    throw new Error("missing YAML frontmatter (expected --- delimiters)");
  }
  const props = parseYaml(match[1]);
  if (!props || typeof props !== "object") {
    throw new Error("invalid YAML frontmatter (expected object)");
  }
  return props;
}

// === FORBIDDEN PATTERNS ===
function checkForbidden(content) {
  const errors = [];
  if (/\[\[.+?\]\]/.test(content)) {
    errors.push("wikilinks forbidden (use markdown links)");
  }
  return errors;
}

// === HEADING VALIDATION ===
function extractH2Headings(content) {
  return [...content.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
}

function checkRequiredHeadings(
  content,
  requiredHeadings,
  { prefix = false } = {}
) {
  const actual = extractH2Headings(content);
  const errors = [];
  for (const req of requiredHeadings) {
    const found = prefix
      ? actual.some((h) => h === req || h.startsWith(`${req} `))
      : actual.includes(req);
    if (!found) {
      errors.push(`missing required heading: ## ${req}`);
    }
  }
  return errors;
}

// === VALIDATORS ===
function validateDoc(file, props, content, allIds) {
  const errors = [];

  for (const key of DOC_REQUIRED) {
    if (props[key] === undefined || props[key] === null || props[key] === "") {
      errors.push(`missing required key: ${key}`);
    }
  }

  if (props.status !== "draft" && !props.verified) {
    errors.push(`verified required when status != draft`);
  }

  if (props.type && !DOC_TYPES.includes(props.type)) {
    errors.push(`invalid type: ${props.type}`);
  }
  if (props.status && !DOC_STATUS.includes(props.status)) {
    errors.push(`invalid status: ${props.status}`);
  }
  if (props.trust && !DOC_TRUST.includes(props.trust)) {
    errors.push(`invalid trust: ${props.trust}`);
  }
  if (
    props.type === "adr" &&
    props.decision &&
    !ADR_DECISION.includes(props.decision)
  ) {
    errors.push(`invalid decision: ${props.decision}`);
  }

  const created = String(props.created || "");
  const verified = String(props.verified || "");
  if (props.created && !DATE_REGEX.test(created)) {
    errors.push(`invalid created date: ${props.created}`);
  }
  if (props.verified && !DATE_REGEX.test(verified)) {
    errors.push(`invalid verified date: ${props.verified}`);
  }

  // Type must match directory
  const dirMatch = file.match(/docs\/([^/]+)\//);
  const dirType = dirMatch?.[1];
  const dirTypeMap = {
    spec: "spec",
    guides: "guide",
    decisions: "adr",
    research: "research",
    postmortems: "postmortem",
  };
  const expectedType = dirTypeMap[dirType];
  if (expectedType && props.type && expectedType !== props.type) {
    errors.push(
      `type "${props.type}" does not match directory "${dirType}" (expected "${expectedType}")`
    );
  }

  if (props.id) {
    if (allIds.has(props.id)) {
      errors.push(
        `duplicate id: ${props.id} (also in ${allIds.get(props.id)})`
      );
    } else {
      allIds.set(props.id, file);
    }
  }

  // Docs-specific forbidden fields
  for (const key of DOCS_FORBIDDEN) {
    if (props[key] !== undefined) {
      errors.push(`field "${key}" forbidden in /docs (wrong field set)`);
    }
  }

  // Heading checks (spec gated on spec_state; ADR always)
  if (props.type === "spec" && props.spec_state) {
    errors.push(...checkRequiredHeadings(content, SPEC_REQUIRED_HEADINGS));
    // Accept either "Invariants" or "Core Invariants"
    const h2s = extractH2Headings(content);
    if (!h2s.includes("Invariants") && !h2s.includes("Core Invariants")) {
      errors.push(`missing required heading: ## Invariants`);
    }
  }
  if (props.type === "adr") {
    errors.push(...checkRequiredHeadings(content, ADR_REQUIRED_HEADINGS));
  }
  if (props.type === "postmortem") {
    errors.push(
      ...checkRequiredHeadings(content, POSTMORTEM_REQUIRED_HEADINGS, {
        prefix: true,
      })
    );
  }

  return errors;
}

// === MAIN ===
async function main() {
  let hasErrors = false;
  const allIds = new Map();
  // Validate docs
  const docFiles = await fg([
    "docs/spec/**/*.md",
    "docs/guides/**/*.md",
    "docs/research/**/*.md",
  ]);
  for (const f of docFiles) {
    try {
      const content = readFileSync(f, "utf8");
      const props = extractFrontmatter(content);
      const errors = [
        ...checkForbidden(content),
        ...validateDoc(f, props, content, allIds),
      ];
      if (errors.length) {
        hasErrors = true;
        for (const e of errors) console.error(`${f}: ${e}`);
      }
    } catch (e) {
      hasErrors = true;
      console.error(`${f}: ${e.message}`);
    }
  }

  if (hasErrors) process.exit(1);

  console.log(
    `docs metadata OK (${docFiles.length} files, ${allIds.size} unique ids)`
  );
}

main().catch((e) => {
  console.error("validate-docs-metadata: internal error", e);
  process.exit(2);
});
