// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-doc-headers`
 * Purpose: Validates SPDX headers and TSDoc headers in TypeScript files for required documentation fields and format compliance.
 * Scope: Scans e2e, infra, scripts, src, tests directories for .ts/.tsx files; does not validate runtime behavior or generated files.
 * Invariants: Required fields non-empty; Module matches `@layer/path` pattern; SPDX headers exact match.
 * Side-effects: IO
 * Notes: Supports parenthetical descriptions in side-effects; supports Next.js dynamic routes [] and route groups (); enforces unified header format.
 * Links: https://node-template.cognidao.org/knowledge/code-style-standard, scripts/validate-agents-md.mjs
 * @internal
 */

import { readFileSync } from "node:fs";
import { relative } from "node:path";

import { glob } from "fast-glob";

interface Violation {
  file: string;
  code: string;
  msg: string;
  line: number;
  col: number;
}

const INCLUDE = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [
      "e2e/**/*.{ts,tsx,js,mjs,cjs}",
      "infra/**/*.{ts,tsx,js,mjs,cjs}",
      "packages/**/*.{ts,tsx,js,mjs,cjs}",
      "scripts/**/*.{ts,tsx,js,mjs,cjs}",
      "src/**/*.{ts,tsx,js,mjs,cjs}",
      "tests/**/*.{ts,tsx,js,mjs,cjs}",
    ];
const EXCLUDE = [
  "**/*.d.ts",
  "**/dist/**",
  "**/generated/**",
  "**/fixtures/**",
  "**/icons/**",
  "**/node_modules/**",
  "**/*.svg.tsx",
  "docs/**",
  // Vendor components maintain their own licensing
  "**/vendor/**",
  // node-ui-kit re-vendored shadcn/reui — same licensing rationale as vendor/
  "**/node-ui-kit/src/shadcn/**",
  "**/node-ui-kit/src/reui/**",
];
const MAX_HEADER_LINES = 40;
const ALLOWED_SIDE_EFFECTS = [
  "none",
  "IO",
  "time",
  "randomness",
  "process.env",
  "global",
];
const MODULE_PATTERN = /^`@[A-Za-z0-9_/.[\]()-]+`$/;

// REUSE-IgnoreStart
const SPDX_LICENSE =
  "// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0";
const SPDX_COPYRIGHT = "// SPDX-FileCopyrightText: 2025 Cogni-DAO";
// REUSE-IgnoreEnd

// Anchored label regexes inside a TSDoc block line prefix "*"
const RX = {
  module: /^\s*\*\s*Module:\s*(.+)\s*$/m,
  purpose: /^\s*\*\s*Purpose:\s*(.+)\s*$/m,
  scope: /^\s*\*\s*Scope:\s*(.+)\s*$/m,
  invariants: /^\s*\*\s*Invariants:\s*(.+)\s*$/m,
  sideEffects: /^\s*\*\s*Side-effects:\s*(.+)\s*$/m,
  notes: /^\s*\*\s*Notes:\s*(.+)\s*$/m,
  links: /^\s*\*\s*Links:\s*(.+)\s*$/m,
  visibility: /^\s*\*\s*@(public|internal|beta)\s*$/m,
};

const SPDX_LINE = /^\s*\/\/\s*SPDX-/;
const JS_DOC_OPEN = "/**";
const JS_DOC_CLOSE = "*/";

function err(
  file: string,
  code: string,
  msg: string,
  line = 1,
  col = 1
): Violation {
  return { file, code, msg, line, col };
}

function validateSpdxHeader(file: string, source: string): Violation[] {
  const v: Violation[] = [];
  const lines = source.split(/\r?\n/);

  let i = 0;

  // Optional shebang for scripts
  if (lines[i]?.startsWith("#!")) i++;

  const licenseLine = lines[i] ?? "";
  const copyrightLine = lines[i + 1] ?? "";

  if (licenseLine.trim() !== SPDX_LICENSE) {
    v.push(
      err(
        file,
        "SH001",
        `missing-or-wrong-SPDX-license: expected "${SPDX_LICENSE}"`,
        i + 1
      )
    );
  }
  if (copyrightLine.trim() !== SPDX_COPYRIGHT) {
    v.push(
      err(
        file,
        "SH002",
        `missing-or-wrong-SPDX-copyright: expected "${SPDX_COPYRIGHT}"`,
        i + 2
      )
    );
  }

  return v;
}

function findHeader(
  source: string
): { header: string; startLine: number; endLine: number } | null {
  const lines = source.split(/\r?\n/);
  let i = 0;

  // Optional shebang for scripts
  if (lines[i]?.startsWith("#!")) i++;

  // allow up to 2 SPDX lines
  let spdxCount = 0;
  while (i < lines.length && lines[i] && SPDX_LINE.test(lines[i] ?? "")) {
    i++;
    spdxCount++;
    i++;
    if (spdxCount > 2) break;
  }
  // header must start within first 5 non-empty lines after SPDX
  const searchWindowEnd = Math.min(i + 5, lines.length);
  for (let j = i; j < searchWindowEnd; j++) {
    const l = lines[j]?.trim();
    if (l?.startsWith(JS_DOC_OPEN)) {
      // find end
      for (let k = j; k < Math.min(j + MAX_HEADER_LINES, lines.length); k++) {
        if (lines[k]?.includes(JS_DOC_CLOSE)) {
          const startIdx = j;
          const endIdx = k;
          const header = lines.slice(startIdx, endIdx + 1).join("\n");
          return { header, startLine: startIdx + 1, endLine: endIdx + 1 };
        }
      }
      // too long or no close
      return null;
    }
    if (l && l.length > 0 && !l.startsWith("//")) {
      // first non-empty non-SPDX non-comment line is code => no header first
      break;
    }
  }
  return null;
}

function validateHeader(file: string, header: string): Violation[] {
  const v: Violation[] = [];
  const headerLineCount = header.split(/\r?\n/).length;
  if (headerLineCount > MAX_HEADER_LINES) {
    v.push(
      err(
        file,
        "DH008",
        `header-too-long: ${headerLineCount} > ${MAX_HEADER_LINES}`
      )
    );
  }

  const requireLabel = (name: keyof typeof RX): string => {
    const m = RX[name].exec(header);
    if (!m) v.push(err(file, "DH003", `missing-label:${name}`));
    else if (!m[1]?.trim()) v.push(err(file, "DH004", `empty-label:${name}`));
    return m?.[1]?.trim() ?? "";
  };

  const moduleValue = requireLabel("module");
  const purpose = requireLabel("purpose");
  const scope = requireLabel("scope");
  const invariants = requireLabel("invariants");
  const sideEffects = requireLabel("sideEffects");
  const links = requireLabel("links");

  // Optional labels
  const notes = RX.notes.exec(header)?.[1]?.trim() ?? "";
  const visibility = RX.visibility.exec(header)?.[1] ?? "";

  // Module: must match the expected format pattern
  if (moduleValue && !MODULE_PATTERN.test(moduleValue)) {
    v.push(err(file, "DH010", `module-format-invalid: "${moduleValue}"`));
  }

  // Purpose: ≤ ~400 chars and at least one period
  if (purpose) {
    if (purpose.length > 400) v.push(err(file, "DH004", "purpose-too-long"));
    if (!/[.!?]/.test(purpose))
      v.push(err(file, "DH004", "purpose-needs-sentence"));
  }

  // Scope: must include a negative clause indicator
  if (scope && !/\b(not|doesn'?t|does not)\b/i.test(scope)) {
    v.push(err(file, "DH004", "scope-must-include-negative-clause"));
  }

  // Invariants: allow up to 3 bullets separated by ";" or "•" or list-like text
  if (invariants) {
    const items = invariants
      .split(/(?:^|\s)[-*•;]\s+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length > 3)
      v.push(err(file, "DH006", `invariants-too-many:${items.length}`));
    if (items.some((x) => x.length > 140))
      v.push(err(file, "DH006", "invariants-item-too-long"));
  }

  // Side-effects: comma-separated allowed tokens (with optional parenthetical descriptions)
  if (sideEffects) {
    // First extract the base tokens, handling parenthetical descriptions properly
    // Split on commas not inside parentheses
    const tokens = sideEffects
      .split(/,(?![^()]*\))/)
      .map((t) => t.trim().split(/\s*\(/)[0])
      .filter((t): t is string => Boolean(t));
    const invalid = tokens.filter((t) => !ALLOWED_SIDE_EFFECTS.includes(t));
    if (invalid.length > 0)
      v.push(err(file, "DH005", `side-effects-invalid:${invalid.join("|")}`));
    if (new Set(tokens).size !== tokens.length)
      v.push(err(file, "DH005", "side-effects-duplicate"));
  }

  // Notes: up to 3 bullets
  if (notes) {
    const items = notes
      .split(/(?:^|\s)[-*•;]\s+/g)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length > 3)
      v.push(err(file, "DH007", `notes-too-many:${items.length}`));
    if (items.some((x) => x.length > 140))
      v.push(err(file, "DH007", "notes-item-too-long"));
  }

  // Links: at least one token
  if (links) {
    const items = links
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (items.length === 0) v.push(err(file, "DH004", "links-empty"));
  }

  // Visibility: if present must be single and valid
  const visTags = Array.from(
    header.matchAll(/^\s*\*\s*@(public|internal|beta)\s*$/gm)
  ).map((m) => m[1]);
  if (visTags.length > 1) v.push(err(file, "DH009", "visibility-multiple"));
  if (
    visTags.length === 1 &&
    !["public", "internal", "beta"].includes(visibility)
  )
    v.push(err(file, "DH009", "visibility-invalid"));

  return v;
}

async function main(): Promise<void> {
  const files = await glob(INCLUDE, { ignore: EXCLUDE, absolute: true });
  const violations: Violation[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const fileRel = relative(process.cwd(), f);

    // 1) SPDX first
    violations.push(...validateSpdxHeader(fileRel, src));

    // 2) Then header detection + label validation
    const header = findHeader(src);
    if (!header) {
      violations.push(err(fileRel, "DH001", "missing-header"));
      continue;
    }
    const vs = validateHeader(fileRel, header.header);
    violations.push(...vs);
  }
  if (violations.length) {
    for (const v of violations) {
      console.error(`${v.file}:${v.line}:${v.col}  ${v.code}  ${v.msg}`);
    }
    process.exit(1);
  }
  console.log(`doc-header-check: OK (${files.length} files)`);
}

main().catch((e) => {
  console.error("doc-header-check: internal-error", e);
  process.exit(2);
});
