// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-app-scaffold/gens/scope-filters`
 * Purpose: Pure TS port of `scripts/ci/render-scope-filters.sh --write` — splice a new
 *   non-operator node's `single-node-scope` dorny/paths-filter entry into a committed
 *   `.github/workflows/ci.yaml`, so the wizard authors a node-birth PR without a checkout.
 * Scope: Operates on the GENERATED block between the sentinels; parses the existing
 *   non-operator slugs out of the block, adds the new one, byte-exact rewrites. No IO.
 * Invariants: BLOCK_IS_SSOT — output is byte-identical to the shell renderer (12-space
 *   indent, LC_ALL=C/ASCII slug sort, `<slug>:` + `  - 'nodes/<slug>/**'` per node, then
 *   `operator:` + `  - '**'` + a `  - '!nodes/<slug>/**'` negation per node).
 * Side-effects: none
 * Links: scripts/ci/render-scope-filters.sh, task.5092
 * @public
 */

const INDENT = "            "; // 12 spaces — the filter body indent inside `filters: |`
const OPERATOR_NODE = "operator";
const BEGIN =
  "# >>> GENERATED scope-filters (scripts/ci/render-scope-filters.sh) — DO NOT EDIT BY HAND";
const END = "# <<< GENERATED scope-filters";

/** LC_ALL=C / byte-wise ASCII comparison (not locale-aware). */
function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Parse the non-operator slugs from a positive `- 'nodes/<slug>/**'` filter line. */
const FILTER_LINE = /^\s*- 'nodes\/([^/]+)\/\*\*'$/;

/** Render the sentinel-bounded GENERATED block for the given sorted slug list. */
function renderBlock(nodes: readonly string[]): string {
  const lines: string[] = [`${INDENT}${BEGIN}`];
  for (const node of nodes) {
    lines.push(`${INDENT}${node}:`);
    lines.push(`${INDENT}  - 'nodes/${node}/**'`);
  }
  lines.push(`${INDENT}${OPERATOR_NODE}:`);
  lines.push(`${INDENT}  - '**'`);
  for (const node of nodes) {
    lines.push(`${INDENT}  - '!nodes/${node}/**'`);
  }
  lines.push(`${INDENT}${END}`);
  return lines.join("\n");
}

/**
 * Splice a new non-operator node `slug` into a committed ci.yaml, returning the new
 * ci.yaml byte-identical to `render-scope-filters.sh --write` once `nodes/<slug>/` exists.
 */
export function insertScopeFilter(currentCiYaml: string, slug: string): string {
  const lines = currentCiYaml.split("\n");
  const beginIdx = lines.findIndex((l) => l.includes(BEGIN));
  const endIdx = lines.findIndex((l) => l.includes(END));
  if (beginIdx === -1 || endIdx === -1 || endIdx < beginIdx) {
    throw new Error(
      "ci.yaml is missing the GENERATED scope-filters sentinels; cannot splice."
    );
  }

  // The negation lines all carry a leading `!`, so the positive filter regex skips
  // them and yields exactly one slug per non-operator node section.
  const slugs = new Set<string>();
  for (let i = beginIdx + 1; i < endIdx; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = FILTER_LINE.exec(line);
    if (match?.[1]) {
      slugs.add(match[1]);
    }
  }
  slugs.add(slug);

  const sorted = [...slugs].sort(asciiCompare);
  const block = renderBlock(sorted).split("\n");

  return [
    ...lines.slice(0, beginIdx),
    ...block,
    ...lines.slice(endIdx + 1),
  ].join("\n");
}
