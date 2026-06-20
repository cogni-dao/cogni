// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/node-local-paths`
 * Purpose: Tier-3 (node identity / presentation) path declaration for fork sync. Parses the
 *   `node_local:` glob block out of a node-template `.cogni/sync-manifest.yaml`, with a hardcoded
 *   default so older template revisions (no block) still carve the obvious presentation surface.
 * Scope: Pure — no IO. The facade reads the manifest text via the App; this module turns it into a
 *   typed glob list + a matcher. Reused by the adapter to restore the fork's version of these paths.
 * Invariants:
 *   - TIER3_IS_DATA: the node-local set is DECLARED in node-template's sync-manifest, not hardcoded in
 *     the operator. The default below is a floor, used only when the source manifest omits the block.
 *   - NEVER_SYNCED: a path matched here is carved OUT of the Tier-2 upstream merge — node-template is a
 *     starter, so its identity/presentation never overwrites a fork's. (spec.repo-sync-contract, Tier 3.)
 * Side-effects: none
 * Links: .cogni/sync-manifest.yaml, src/app/_facades/deploy/canonical-fork-sync.server.ts,
 *   src/adapters/server/vcs/github-repo-write.ts, docs/spec/repo-sync-contract.md
 * @public
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";

/**
 * Floor Tier-3 set — used only when the source manifest carries no `node_local:` block (older
 * node-template revisions). The live SSOT is node-template's `.cogni/sync-manifest.yaml#node_local`;
 * keep this in sync with the manifest's documented default but never let it be the only declaration.
 */
export const DEFAULT_NODE_LOCAL_PATHS: readonly string[] = [
  // Public-facing pages (homepage, landing, marketing routes) — the node's face.
  "app/src/app/(public)/**",
  // Home/landing feature surface (components, copy, hero).
  "app/src/features/home/**",
  // Branding / theme / visual identity.
  "app/src/styles/branding/**",
  "app/src/app/branding/**",
  "public/branding/**",
  // Node identity + persona — the repo-spec and any persona/character files.
  ".cogni/repo-spec.yaml",
  ".cogni/persona/**",
] as const;

/** Schema for the `node_local:` block of a sync manifest. Absent ⇒ fall back to the default floor. */
const NodeLocalManifestSchema = z.object({
  node_local: z.array(z.string().min(1)).optional(),
});

/**
 * Parse the Tier-3 (`node_local`) glob list out of a `.cogni/sync-manifest.yaml` body. Returns the
 * declared list when present, else {@link DEFAULT_NODE_LOCAL_PATHS}. Malformed YAML / wrong shape also
 * falls back to the default (fail-safe: a parse error must never let presentation leak into a fork).
 */
export function parseNodeLocalPaths(
  manifestYaml: string | null | undefined
): readonly string[] {
  if (!manifestYaml) return DEFAULT_NODE_LOCAL_PATHS;
  let parsed: unknown;
  try {
    parsed = parseYaml(manifestYaml);
  } catch {
    return DEFAULT_NODE_LOCAL_PATHS;
  }
  const result = NodeLocalManifestSchema.safeParse(parsed);
  if (!result.success || !result.data.node_local?.length) {
    return DEFAULT_NODE_LOCAL_PATHS;
  }
  return result.data.node_local;
}

const REGEX_META = new Set([
  ".",
  "+",
  "?",
  "^",
  "$",
  "{",
  "}",
  "(",
  ")",
  "|",
  "[",
  "]",
  "\\",
]);

/** Compile a single repo-relative glob (`**`, `*`) into an anchored RegExp. Mirrors detect-sync-drift.mjs. */
function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i] as string;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i++;
      } else {
        out += "[^/]*";
      }
    } else if (REGEX_META.has(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Build a predicate that tests whether a repo-relative path is node-local (Tier 3) given a glob list.
 * Compiles each glob once; the returned closure is cheap to call per tree entry.
 */
export function makeNodeLocalMatcher(
  nodeLocalPaths: readonly string[]
): (path: string) => boolean {
  const regexes = nodeLocalPaths.map(globToRegex);
  return (path: string) => regexes.some((re) => re.test(path));
}
