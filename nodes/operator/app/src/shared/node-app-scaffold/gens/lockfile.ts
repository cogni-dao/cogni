// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/lockfile`
 * Purpose: Pure TS splice of a freshly-cloned node's three workspace packages into a committed
 *   `pnpm-lock.yaml`, so the wizard can author a node-birth PR without running `pnpm install`.
 * Scope: Given the CURRENT `pnpm-lock.yaml` and a new node `slug`, return the lockfile
 *   byte-identical to what `pnpm install --lockfile-only` produces after `scaffold-node.sh <slug>`
 *   clones `node-template` (adding `nodes/<slug>/{app,graphs,packages/doltgres-schema}`).
 * Why no resolution is needed: a clone of `node-template` introduces ZERO new external versions —
 *   every importer entry is either `workspace:*` (a `link:` to an existing package) or a shared
 *   external already pinned by another importer. So the deterministic delta is purely the three
 *   `nodes/node-template/…` importer blocks copied under `nodes/<slug>/…`. The ONLY occurrences of
 *   `node-template` inside those blocks are the importer-path keys themselves (the dependency
 *   `link:` targets are depth-invariant `../../../packages/…`, and an importer block never names
 *   its own package), so the transform reduces to: copy the blocks, rewrite the key prefix, and
 *   insert the trio at the lexicographically-correct importer position.
 * Invariants: CLONE_ADDS_NO_PACKAGES — output adds importer blocks only, never `packages:`/
 *   `snapshots:` entries. IMPORTERS_ARE_SORTED — pnpm keeps importer keys in ascending order;
 *   `nodes/<slug>/…` is inserted to preserve it.
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: scripts/setup/scaffold-node.sh, docs/guides/create-node.md, task.5092
 * @public
 */

const TEMPLATE_SLUG = "node-template";

/** The three workspace packages a node-template clone contributes, in pnpm's sorted order. */
const NODE_SUBPATHS = ["app", "graphs", "packages/doltgres-schema"] as const;

const importerKey = (slug: string, subpath: string): string =>
  `  nodes/${slug}/${subpath}:`;

/**
 * Extract the full lines of a top-level importer block keyed `  nodes/<slug>/<subpath>:`,
 * inclusive of the key line and every following body line up to (but not including) the next
 * top-level importer key or the `packages:` section. The trailing blank separator line is
 * intentionally excluded; insertion re-adds separators uniformly.
 */
function extractImporterBlock(lines: string[], key: string): string[] {
  const start = lines.indexOf(key);
  if (start === -1) {
    throw new Error(`pnpm-lock.yaml: importer block not found: ${key.trim()}`);
  }
  let end = start + 1;
  // Body lines are indented deeper than the 2-space key; a new top-level key or a
  // dedented section header (e.g. `packages:`) terminates the block. Blank lines belong
  // to whatever follows, so stop at the first one too.
  while (end < lines.length) {
    const line = lines[end];
    if (line === undefined || line === "" || !line.startsWith("    ")) break;
    end += 1;
  }
  return lines.slice(start, end);
}

/** Rewrite a node-template importer block's key to target `slug`; body lines are untouched. */
function retargetBlock(
  block: string[],
  slug: string,
  subpath: string
): string[] {
  const [, ...body] = block;
  return [importerKey(slug, subpath), ...body];
}

/**
 * Splice the three `nodes/<slug>/…` importer blocks into `currentLockfile`, byte-identical to
 * `pnpm install --lockfile-only` after a `node-template` clone. Pure function.
 *
 * @param currentLockfile the current `pnpm-lock.yaml` contents
 * @param slug the new node's lowercase slug, e.g. `canary`
 * @returns the spliced lockfile contents
 * @public
 */
export function insertLockfileImporters(
  currentLockfile: string,
  slug: string
): string {
  const lines = currentLockfile.split("\n");

  // Build the renamed blocks from node-template's, each followed by one blank separator —
  // mirroring how pnpm emits consecutive importer blocks.
  const newSection: string[] = [];
  for (const subpath of NODE_SUBPATHS) {
    const source = extractImporterBlock(
      lines,
      importerKey(TEMPLATE_SLUG, subpath)
    );
    newSection.push(...retargetBlock(source, slug, subpath), "");
  }

  // Insert before the first importer key that sorts after `nodes/<slug>/app:` — preserving
  // pnpm's ascending importer order. Importer keys are the 2-space-indented `…:` lines between
  // the `importers:` header and the `packages:` section.
  const anchorKey = importerKey(slug, NODE_SUBPATHS[0]).trimEnd();
  const importersHeader = lines.indexOf("importers:");
  if (importersHeader === -1) {
    throw new Error("pnpm-lock.yaml: missing `importers:` section");
  }

  let insertAt = -1;
  for (let i = importersHeader + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) continue;
    if (line === "packages:") {
      insertAt = i;
      break;
    }
    const isImporterKey =
      line.startsWith("  ") && !line.startsWith("   ") && line.endsWith(":");
    if (isImporterKey && line.trimEnd() > anchorKey) {
      insertAt = i;
      break;
    }
  }
  if (insertAt === -1) {
    throw new Error(
      "pnpm-lock.yaml: could not locate importer insertion point"
    );
  }

  return [
    ...lines.slice(0, insertAt),
    ...newSection,
    ...lines.slice(insertAt),
  ].join("\n");
}
