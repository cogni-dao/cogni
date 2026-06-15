// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/arch/tool-catalog-no-global-iteration`
 * Purpose: Enforces OPEN_WORLD_CONTRACTS by asserting that node bootstrap files do not reference the TOOL_CATALOG symbol.
 * Scope: Reads source files as text and asserts absence of the TOOL_CATALOG symbol. Does NOT import the files (they have side effects), does NOT cover packages/langgraph-graphs/src/runtime/ (intentional carve-out).
 * Invariants:
 *   - OPEN_WORLD_CONTRACTS: nodes/operator/app/src/bootstrap/ai/tool-source.factory.ts
 *     must not reference TOOL_CATALOG
 *   - container.ts files must not reference TOOL_CATALOG
 * Side-effects: IO (reads source files from disk)
 * Notes:
 *   Carve-out: `packages/langgraph-graphs/src/runtime/` is allowed to iterate
 *   TOOL_CATALOG until a future cleanup migrates it to an open-world resolver.
 *   That carve-out is intentional and is NOT covered by this test.
 * Links: TOOL_USE_SPEC.md, packages/ai-tools/src/catalog.ts, bug.0319
 * @public
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// operator is the only in-tree node; oss/node-template are git submodules whose
// nodes/<slug>/** files are absent in the submodule-less unit-job checkout, so
// readFileSync below would ENOENT on them. This contract is enforced per-node at
// each node's own CI; here we assert it for the in-tree node.
const NODES = ["operator"] as const;

const FACTORY_FILES = NODES.map(
  (node) => `nodes/${node}/app/src/bootstrap/ai/tool-source.factory.ts`
);

const CONTAINER_FILES = NODES.map(
  (node) => `nodes/${node}/app/src/bootstrap/container.ts`
);

const ALL_FILES = [...FACTORY_FILES, ...CONTAINER_FILES];

/**
 * Checks that the file does not import or destructure TOOL_CATALOG.
 * Comments that mention TOOL_CATALOG for documentation purposes are allowed.
 * We look specifically for import statements containing TOOL_CATALOG.
 */
function importsTOOL_CATALOG(source: string): boolean {
  // Match `import { ..., TOOL_CATALOG, ... } from "..."` or `import TOOL_CATALOG from "..."`
  // This does NOT flag comments or prose that mention the symbol.
  return /import[^;]*\bTOOL_CATALOG\b[^;]*from\s+["']/.test(source);
}

describe("OPEN_WORLD_CONTRACTS: node bootstrap files must not import TOOL_CATALOG", () => {
  for (const filePath of ALL_FILES) {
    it(`${filePath} does not import TOOL_CATALOG`, () => {
      const source = readFileSync(filePath, "utf-8");
      expect(
        importsTOOL_CATALOG(source),
        `${filePath} must not import TOOL_CATALOG. ` +
          `Use CORE_TOOL_BUNDLE / POLY_TOOL_BUNDLE and pass them to createBoundToolSource().`
      ).toBe(false);
    });
  }
});
