#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-docs-metadata`
 * Purpose: Validates Obsidian-style YAML frontmatter in /docs and /work directories.
 * Scope: Enforces field requirements, enums, date format, field set separation, and required H2 headings; does NOT validate prose content or cross-references.
 * Invariants: /docs uses id/type/status/trust; /work items use id/type/status; no wikilinks.
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

// === WORK ENUMS ===
const ITEM_STATUS = [
  "needs_triage",
  "needs_research",
  "needs_design",
  "needs_implement",
  "needs_review",
  "needs_closeout",
  "needs_merge",
  "done",
  "blocked",
  "cancelled",
];
const ITEM_TYPES = ["task", "bug", "spike", "story", "subtask"];
const PRIORITY = [0, 1, 2, 3];
const ESTIMATE = [0, 1, 2, 3, 4, 5];

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

// === REQUIRED H2 HEADINGS (per doc type) ===
// Spec headings gated on spec_state being present (exempts legacy specs and indexes)
const SPEC_REQUIRED_HEADINGS = ["Design", "Goal", "Non-Goals"];
const ADR_REQUIRED_HEADINGS = ["Decision", "Rationale", "Consequences"];
const CHARTER_REQUIRED_HEADINGS = ["Goal", "Projects", "Constraints"];
const POSTMORTEM_REQUIRED_HEADINGS = ["Summary", "Timeline"];
const ITEM_REQUIRED_HEADINGS = ["Validation"];

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
const CHARTER_REQUIRED = [
  "id",
  "type",
  "title",
  "state",
  "summary",
  "created",
  "updated",
];
const ITEM_REQUIRED = [
  "id",
  "type",
  "title",
  "status",
  "priority",
  "rank",
  "estimate",
  "summary",
  "outcome",
  "assignees",
  "created",
  "updated",
];

// === FORBIDDEN FIELDS (docs tree only — work tree now shares id/type/status) ===
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

function validateCharter(file, props, content, allIds) {
  const errors = [];

  for (const key of CHARTER_REQUIRED) {
    if (props[key] === undefined || props[key] === null || props[key] === "") {
      errors.push(`missing required key: ${key}`);
    }
  }

  if (props.type !== "charter") {
    errors.push(`type must be "charter"`);
  }
  if (props.id && !String(props.id).startsWith("chr.")) {
    errors.push(`id must start with "chr."`);
  }

  const created = String(props.created || "");
  const updated = String(props.updated || "");
  if (props.created && !DATE_REGEX.test(created)) {
    errors.push(`invalid created date: ${props.created}`);
  }
  if (props.updated && !DATE_REGEX.test(updated)) {
    errors.push(`invalid updated date: ${props.updated}`);
  }

  if (props.id) {
    const id = String(props.id);
    if (allIds.has(id)) {
      errors.push(`duplicate id: ${id}`);
    } else {
      allIds.set(id, file);
    }
  }

  errors.push(...checkRequiredHeadings(content, CHARTER_REQUIRED_HEADINGS));

  return errors;
}

function validateItem(file, props, content, allIds) {
  const errors = [];

  const TRIAGE_OPTIONAL = ["priority", "rank", "estimate"];
  for (const key of ITEM_REQUIRED) {
    if (props[key] === undefined || props[key] === null || props[key] === "") {
      if (props.status === "needs_triage" && TRIAGE_OPTIONAL.includes(key)) {
        continue;
      }
      errors.push(`missing required key: ${key}`);
    }
  }

  if (props.type && !ITEM_TYPES.includes(props.type)) {
    errors.push(
      `invalid type: ${props.type} (expected: ${ITEM_TYPES.join("|")})`
    );
  }
  if (props.status && !ITEM_STATUS.includes(props.status)) {
    errors.push(
      `invalid status: ${props.status} (expected: ${ITEM_STATUS.join("|")})`
    );
  }
  if (
    props.priority !== undefined &&
    props.priority !== null &&
    !PRIORITY.includes(props.priority)
  ) {
    errors.push(
      `invalid priority: ${props.priority} (expected: ${PRIORITY.join("|")})`
    );
  }
  if (
    props.estimate !== undefined &&
    props.estimate !== null &&
    !ESTIMATE.includes(props.estimate)
  ) {
    errors.push(
      `invalid estimate: ${props.estimate} (expected: ${ESTIMATE.join("|")})`
    );
  }
  if (
    props.rank !== undefined &&
    props.rank !== null &&
    props.rank !== "" &&
    (!Number.isInteger(props.rank) || props.rank < 1)
  ) {
    errors.push(
      `invalid rank: ${props.rank} (expected positive integer, 1 = highest)`
    );
  }

  // id must be <type>.<num> and match filename prefix
  if (props.id) {
    const id = String(props.id);
    const idMatch = id.match(/^([a-z]+)\.(\d+)$/);
    if (!idMatch) {
      errors.push(`id must be <type>.<num> (got "${id}")`);
    } else {
      const [, idType, idNum] = idMatch;
      if (!ITEM_TYPES.includes(idType)) {
        errors.push(`id type prefix "${idType}" not in allowed types`);
      }
      if (props.type && idType !== props.type) {
        errors.push(
          `id type "${idType}" does not match type field "${props.type}"`
        );
      }
      // filename prefix must match id
      const basename = file.split("/").pop();
      if (!basename.startsWith(`${idType}.${idNum}`)) {
        errors.push(
          `filename "${basename}" must start with "${idType}.${idNum}"`
        );
      }
    }
  }

  // branch field (optional) must be non-empty string when present
  if (props.branch !== undefined && props.branch !== null) {
    if (typeof props.branch !== "string" || props.branch.trim() === "") {
      errors.push(`branch must be a non-empty string when present`);
    }
  }

  // project field (optional) must reference proj.*
  if (props.project) {
    const proj = String(props.project);
    if (!proj.startsWith("proj.")) {
      errors.push(`project must reference "proj.*"`);
    }
  }

  const created = String(props.created || "");
  const updated = String(props.updated || "");
  if (props.created && !DATE_REGEX.test(created)) {
    errors.push(`invalid created date: ${props.created}`);
  }
  if (props.updated && !DATE_REGEX.test(updated)) {
    errors.push(`invalid updated date: ${props.updated}`);
  }

  if (props.id) {
    const id = String(props.id);
    if (allIds.has(id)) {
      errors.push(`duplicate id: ${id}`);
    } else {
      allIds.set(id, file);
    }
  }

  errors.push(...checkRequiredHeadings(content, ITEM_REQUIRED_HEADINGS));

  return errors;
}

// === MAIN ===
async function main() {
  let hasErrors = false;
  const allIds = new Map();
  // Validate docs
  const docFiles = await fg([
    "docs/spec/**/*.md",
    "docs/decisions/adr/**/*.md",
    "docs/guides/**/*.md",
    "docs/research/**/*.md",
    "docs/postmortems/**/*.md",
    "!docs/research/archive/**/*.md",
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

  // Validate charters
  const charterFiles = await fg(["work/charters/**/*.md"]);
  for (const f of charterFiles) {
    try {
      const content = readFileSync(f, "utf8");
      const props = extractFrontmatter(content);
      const errors = [
        ...checkForbidden(content),
        ...validateCharter(f, props, content, allIds),
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

  // Validate legacy markdown items.
  const itemFiles = await fg(["work/items/**/*.md", "!work/items/_archive/**"]);
  for (const f of itemFiles) {
    try {
      const content = readFileSync(f, "utf8");
      const props = extractFrontmatter(content);
      const errors = [
        ...checkForbidden(content),
        ...validateItem(f, props, content, allIds),
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

  const total =
    docFiles.length +
    charterFiles.length +
    itemFiles.length;
  console.log(
    `docs/work metadata OK (${total} files, ${allIds.size} unique ids)`
  );
}

main().catch((e) => {
  console.error("validate-docs-metadata: internal error", e);
  process.exit(2);
});
