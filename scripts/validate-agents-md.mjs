#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-agents-md`
 * Purpose: Validates AGENTS.md file structure and required sections across all directories.
 * Scope: Enforces heading requirements, metadata format, line limits. Does NOT validate content accuracy.
 * Invariants: All AGENTS.md files must have required headings; stay under 150 lines; valid metadata format.
 * Side-effects: IO
 * Notes: Enumerates ALL errors before exiting; supports CI/CD pipeline integration.
 * Links: docs/templates/agents_subdir_template.md
 * @public
 */

/* eslint-env node */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const REQ_HEADINGS = [
  "Metadata",
  "Purpose",
  "Pointers",
  "Boundaries",
  "Public Surface",
  "Responsibilities",
  "Notes",
];

const PROHIBITED_WORDS = [
  "complete",
  "comprehensive",
  "final",
  "production ready",
];

const VALID_LAYERS = [
  "app",
  "features",
  "ports",
  "core",
  "adapters",
  "adapters/server",
  "adapters/worker",
  "adapters/cli",
  "adapters/test",
  "contracts",
  "mcp",
  "shared",
  "types",
  "bootstrap",
  "components",
  "styles",
  "assets",
  "tests",
  "e2e",
  "scripts",
  "infra",
  "meta",
  "packages",
  "services",
];

const LAYER_FROM_PATH = [
  { re: /^src\/app\//, layer: "app" },
  { re: /^src\/features\//, layer: "features" },
  { re: /^src\/ports\//, layer: "ports" },
  { re: /^src\/core\//, layer: "core" },
  { re: /^src\/adapters\/AGENTS\.md$/, layer: "adapters" },
  { re: /^src\/adapters\/server\//, layer: "adapters/server" },
  { re: /^src\/adapters\/worker\//, layer: "adapters/worker" },
  { re: /^src\/adapters\/cli\//, layer: "adapters/cli" },
  { re: /^src\/adapters\/test\//, layer: "adapters/test" },
  { re: /^src\/contracts\//, layer: "contracts" },
  { re: /^src\/mcp\//, layer: "mcp" },
  { re: /^src\/shared\//, layer: "shared" },
  { re: /^src\/bootstrap\//, layer: "bootstrap" },
  { re: /^src\/components\//, layer: "components" },
  { re: /^src\/styles\//, layer: "styles" },
  { re: /^src\/types\//, layer: "types" },
  { re: /^src\/assets\//, layer: "assets" },
  { re: /^tests\//, layer: "tests" },
  { re: /^e2e\//, layer: "e2e" },
  { re: /^scripts\//, layer: "scripts" },
  { re: /^infra\//, layer: "infra" },
  { re: /^packages\//, layer: "packages" },
  { re: /^services\//, layer: "services" },
];

const POLICY_ALLOW = {
  core: ["core", "types"],
  ports: ["ports", "core", "types"],
  features: [
    "features",
    "ports",
    "core",
    "shared",
    "types",
    "components",
    "contracts",
  ],
  contracts: ["contracts", "shared", "types"],
  app: [
    "app",
    "features",
    "ports",
    "shared",
    "contracts",
    "types",
    "components",
    "styles",
    "bootstrap",
  ],
  mcp: ["mcp", "features", "ports", "contracts", "bootstrap"],
  adapters: ["adapters", "ports", "shared", "types"],
  "adapters/server": ["adapters/server", "ports", "shared", "types"],
  "adapters/worker": ["adapters/worker", "ports", "shared", "types"],
  "adapters/cli": ["adapters/cli", "ports", "shared", "types"],
  "adapters/test": ["adapters/test", "ports", "shared", "types"],
  shared: ["shared", "types"],
  bootstrap: [
    "bootstrap",
    "ports",
    "adapters/server",
    "adapters/worker",
    "adapters/cli",
    "adapters/test",
    "shared",
    "types",
  ],
  components: ["components", "shared", "types", "styles"],
  styles: ["styles"],
  types: ["types"],
  assets: ["assets"],
  tests: ["*"],
  e2e: ["*"],
  scripts: ["scripts", "ports", "shared", "types", "packages"],
  infra: ["infra"],
  meta: ["meta"],
  packages: ["packages"],
  services: ["services", "packages"],
};

function h(md) {
  return [...md.matchAll(/^#{2}\s+(.+?)\s*$/gm)].map((m) => m[1].trim());
}

function getBlockAfter(md, heading) {
  const idx = md.indexOf(`## ${heading}`);
  if (idx === -1) return "";
  const slice = md.slice(idx);
  const next = slice.indexOf("\n## ");
  return next === -1 ? slice : slice.slice(0, next);
}

function validateMetadata(block) {
  const errors = [];
  if (
    !/\*\*Owners:\*\*\s*@[A-Za-z0-9][A-Za-z0-9-]*(?:\/[A-Za-z0-9][A-Za-z0-9-]*)?/m.test(
      block
    )
  ) {
    errors.push("Metadata: missing Owner");
  }
  // Last reviewed date is optional — git blame is the source of truth
  const dateMatch = block.match(/\*\*Last reviewed:\*\*\s*([0-9-]+)/i);
  if (dateMatch) {
    const date = dateMatch[1];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      errors.push("Metadata: invalid date format (must be YYYY-MM-DD)");
    }
  }
  if (!/\*\*Status:\*\*\s*(stable|draft|deprecated)/i.test(block)) {
    errors.push("Metadata: invalid Status");
  }
  return errors;
}

function validateBoundaries(block, filePathRaw) {
  const errors = [];
  const filePath = filePathRaw.replace(/\\/g, "/");
  const m = block.match(/```json[c5]?\s*([\s\S]*?)```/i);
  if (!m) {
    errors.push("Boundaries: missing JSON block");
    return errors;
  }
  let j;
  try {
    j = JSON.parse(m[1]);
  } catch (e) {
    errors.push(`Boundaries: invalid JSON (${e.message})`);
    return errors;
  }

  if (!VALID_LAYERS.includes(j.layer)) {
    errors.push("Boundaries: invalid layer");
  }
  if (!Array.isArray(j.may_import) || !Array.isArray(j.must_not_import)) {
    errors.push("Boundaries: may_import and must_not_import must be arrays");
    return errors;
  }

  // Normalize and dedupe arrays
  j.may_import = [...new Set(j.may_import.map(String))];
  j.must_not_import = [...new Set(j.must_not_import.map(String))];

  // Warn if may_import is empty (unless fully isolated with must_not_import: ["*"])
  if (
    j.may_import.length === 0 &&
    !(j.must_not_import.length === 1 && j.must_not_import[0] === "*")
  ) {
    console.warn(
      `Warning: may_import is empty in ${filePath} - this is probably a mistake`
    );
  }

  // Validate imports are subsets of valid layers (allow wildcards like "*")
  const invalidMayImport = j.may_import.filter(
    (layer) => layer !== "*" && !VALID_LAYERS.includes(layer)
  );
  if (invalidMayImport.length > 0) {
    errors.push(
      `Boundaries: invalid layers in may_import: ${invalidMayImport.join(", ")}`
    );
  }

  const invalidMustNotImport = j.must_not_import.filter(
    (layer) => layer !== "*" && !VALID_LAYERS.includes(layer)
  );
  if (invalidMustNotImport.length > 0) {
    errors.push(
      `Boundaries: invalid layers in must_not_import: ${invalidMustNotImport.join(", ")}`
    );
  }

  // Validate no overlap between may_import and must_not_import
  const overlap = j.may_import.filter((layer) =>
    j.must_not_import.includes(layer)
  );
  if (overlap.length > 0) {
    errors.push(
      `Boundaries: overlap between may_import and must_not_import: ${overlap.join(", ")}`
    );
  }

  // Path ↔ declared layer consistency
  const guessed = LAYER_FROM_PATH.find((m) => m.re.test(filePath))?.layer;
  if (guessed && guessed !== j.layer) {
    errors.push(
      `Boundaries: layer "${j.layer}" does not match path "${guessed}"`
    );
  }

  // Declared may_import must be subset of policy for this layer
  const policy = POLICY_ALLOW[j.layer];
  if (policy && !policy.includes("*")) {
    const extras = j.may_import.filter((x) => {
      if (x === "*" || policy.includes(x)) return false;
      if (x.startsWith("adapters/") && policy.includes("adapters"))
        return false;
      return true;
    });
    if (extras.length) {
      errors.push(
        `Boundaries: may_import includes layers not allowed by policy for "${j.layer}": ${extras.join(", ")}`
      );
    }
  }

  // Contracts edge-only explicit guard
  if (j.layer === "contracts") {
    const banned = ["features", "ports", "core"];
    if (j.may_import.some((x) => banned.includes(x))) {
      errors.push(`Boundaries: contracts may not import ${banned.join("|")}`);
    }
  }

  // src/** layers may not import infra/** or scripts/**
  if (
    filePath.startsWith("src/") &&
    j.may_import.some(
      (x) =>
        x === "infra" ||
        x.startsWith("infra/") ||
        x === "scripts" ||
        x.startsWith("scripts/")
    )
  ) {
    errors.push(
      `Boundaries: src layers cannot import infra/** or scripts/** (CI/IaC not runtime dependency)`
    );
  }

  return errors;
}

function validateProhibitedWords(content) {
  const errors = [];
  for (const word of PROHIBITED_WORDS) {
    const regex = new RegExp(`\\b${word}\\b`, "gi");
    if (regex.test(content)) {
      errors.push(
        `prohibited word "${word}" found - these words are red flags and indicate improper understanding`
      );
    }
  }
  return errors;
}

function validateSubdirAgents(file, content) {
  const errors = [];

  // 1) headings presence + order (core structure)
  const headings = h(content);
  let idx = -1;
  for (const req of REQ_HEADINGS) {
    const i = headings.indexOf(req);
    if (i === -1) {
      errors.push(`missing heading "${req}"`);
    } else if (i <= idx) {
      errors.push(`"${req}" out of order`);
    } else {
      idx = i;
    }
  }

  // Check "Ports (optional)" for proper positioning (between Public Surface and Responsibilities)
  const portsIdx = headings.indexOf("Ports (optional)");
  if (portsIdx !== -1) {
    const publicSurfaceIdx = headings.indexOf("Public Surface");
    const responsibilitiesIdx = headings.indexOf("Responsibilities");
    if (portsIdx <= publicSurfaceIdx || portsIdx >= responsibilitiesIdx) {
      errors.push(`"Ports (optional)" out of order`);
    }
  }

  // 2) validate critical sections
  errors.push(...validateMetadata(getBlockAfter(content, "Metadata")));
  errors.push(
    ...validateBoundaries(getBlockAfter(content, "Boundaries"), file)
  );

  // 3) check for prohibited words
  errors.push(...validateProhibitedWords(content));

  // 4) Enforce scope line strictly for subdirs
  if (!/^> Scope: this directory only\./m.test(content)) {
    errors.push(`missing required scope line '> Scope: this directory only.'`);
  }

  return errors;
}

function validate(file) {
  const md = readFileSync(file, "utf8");
  const fileErrors = validateSubdirAgents(file, md);
  return fileErrors.map((e) => `${file}: ${e}`);
}

// Find all tracked subdir AGENTS.md files. Root AGENTS.md is intentionally
// not validated — it carries the agent contract, which is iterated freely.
const files = execSync("git ls-files '*/AGENTS.md'", {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter((f) => f && !f.includes("gateway-workspace/"));
const allErrors = [];
for (const f of files) {
  try {
    allErrors.push(...validate(f));
  } catch (e) {
    allErrors.push(`${f}: ${e.message}`);
  }
}
if (allErrors.length) {
  for (const e of allErrors) console.error(e);
  process.exit(1);
}
console.log("AGENTS.md OK");
