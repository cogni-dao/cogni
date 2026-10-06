// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/caddyfile`
 * Purpose: Pure port of `scripts/ci/render-caddyfile.sh`'s per-node insert, so the operator can
 *   author a node-formation PR's `Caddyfile.tmpl` edit without a repo checkout or running bash.
 * Scope: Given the CURRENT committed `infra/compose/edge/configs/Caddyfile.tmpl` and a new
 *   NON-PRIMARY node's slug + node_port, return the new content byte-identical to what
 *   `bash scripts/ci/render-caddyfile.sh` emits once that node is in the catalog.
 * Invariants: CATALOG_IS_SSOT — the emitted block mirrors `emit_site_block`'s heredoc exactly;
 *   non-primary nodes stay in `sort`-order; primary (operator) block is never moved.
 * Side-effects: none — pure string transform, no IO, no env.
 * Links: scripts/ci/render-caddyfile.sh, docs/guides/create-node.md, task.5092, bug.5369
 * @public
 */

/** SLUG = `slug | tr '[:lower:]-' '[:upper:]_'` — uppercase, dashes → underscores. */
function slugVar(slug: string): string {
  return slug.toUpperCase().replace(/-/g, "_");
}

/** Mirror of `emit_site_block` for a non-primary node. No leading/trailing blank lines. */
function nonPrimaryBlock(slug: string, nodePort: number): string {
  const upper = slugVar(slug);
  const host = `{$${upper}_DOMAIN:${slug}.localhost}`;
  const upstream = `{$${upper}_UPSTREAM:host.docker.internal:${nodePort}}`;
  return [
    `# ── ${slug} node → k3s NodePort ${nodePort} ──────────────────────────────────`,
    `${host} {`,
    `  encode zstd gzip`,
    ``,
    `  @public path /api/v1/public/*`,
    `  handle @public {`,
    `    reverse_proxy ${upstream} {`,
    `      header_up X-Real-IP {remote_host}`,
    `      transport http {`,
    `        response_header_timeout 10s`,
    `      }`,
    `    }`,
    `  }`,
    ``,
    `  reverse_proxy ${upstream}`,
    ``,
    `  log {`,
    `    format json`,
    `    output stdout`,
    `  }`,
    `}`,
  ].join("\n");
}

/** A site block in the rendered file: leading `# ── <name> ...` comment + the node name it owns. */
interface BlockMatch {
  readonly node: string;
  readonly isPrimary: boolean;
  readonly index: number;
}

const COMMENT_RE =
  /^# ── (?<node>\S+) (?<kind>node|\(primary domain\)) → k3s NodePort /;

/** Locate every `# ── … →` site-block comment, in file order, with its owning node + primacy. */
function findBlocks(lines: readonly string[]): BlockMatch[] {
  const blocks: BlockMatch[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) continue;
    const m = COMMENT_RE.exec(line);
    if (m?.groups?.node) {
      blocks.push({
        node: m.groups.node,
        isPrimary: m.groups.kind === "(primary domain)",
        index,
      });
    }
  }
  return blocks;
}

/**
 * Insert a new non-primary node's reverse-proxy block into the rendered Caddyfile.tmpl,
 * byte-identical to `bash scripts/ci/render-caddyfile.sh` after that node joins the catalog.
 *
 * Non-primary nodes are emitted in shell `sort` order; the new block is spliced into its
 * sorted position (before the first existing non-primary node that sorts after `slug`, else
 * appended). Each block is preceded by a blank line, matching the bash `echo` separators.
 */
export function insertCaddyBlock(
  currentCaddyfile: string,
  slug: string,
  nodePort: number
): string {
  const lines = currentCaddyfile.split("\n");
  const blocks = findBlocks(lines);
  const nonPrimary = blocks.filter((b) => !b.isPrimary);

  if (nonPrimary.some((b) => b.node === slug)) {
    throw new Error(`Caddyfile already contains a block for node '${slug}'`);
  }

  // Each rendered block is preceded by a single blank line (the bash `echo` separator), so
  // the spliced block carries its own leading blank.
  const blockLines = ["", ...nonPrimaryBlock(slug, nodePort).split("\n")];

  // First existing non-primary node that sorts strictly after the new slug (shell `sort`
  // order == JS string `>`), or none when the new node sorts last.
  const successor = nonPrimary.find((b) => b.node > slug);

  // Splice point: the blank line that precedes the successor's comment (so our block lands
  // ahead of it), or — appending last — the trailing "" that `split` leaves for the final
  // newline. Both keep exactly one blank line between adjacent blocks.
  const insertLine = successor ? successor.index - 1 : lines.length - 1;

  return [
    ...lines.slice(0, insertLine),
    ...blockLines,
    ...lines.slice(insertLine),
  ].join("\n");
}

/**
 * Strict inverse of {@link insertCaddyBlock}. Recovery uses this to derive the
 * node-absent trusted-main bytes before replaying the canonical birth plan.
 * Missing, duplicate, or byte-edited contributions fail closed.
 */
export function removeCaddyBlock(
  currentCaddyfile: string,
  slug: string,
  nodePort: number
): string {
  const lines = currentCaddyfile.split("\n");
  const blocks = findBlocks(lines);
  const matches = blocks.filter(
    (block) => !block.isPrimary && block.node === slug
  );
  if (matches.length !== 1) {
    throw new Error(
      `Caddyfile must contain exactly one block for node '${slug}'`
    );
  }
  const match = matches[0];
  if (
    match === undefined ||
    match.index === 0 ||
    lines[match.index - 1] !== ""
  ) {
    throw new Error(`Caddyfile block for node '${slug}' is malformed`);
  }
  const expected = nonPrimaryBlock(slug, nodePort).split("\n");
  const successor = blocks.find((block) => block.index > match.index);
  const boundary = successor ? successor.index - 1 : lines.length - 1;
  if (
    match.index + expected.length !== boundary ||
    lines.slice(match.index, match.index + expected.length).join("\n") !==
    expected.join("\n")
  ) {
    throw new Error(`Caddyfile block for node '${slug}' is not canonical`);
  }
  lines.splice(match.index - 1, expected.length + 1);
  return lines.join("\n");
}
