// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/node-slug`
 * Purpose: Pure validator for a managed node slug.
 * Scope: A node gets its own repo and a deployment pin at `nodes/<slug>/`. Validates the slug shape
 *   and rejects slugs that collide with the existing inline nodes.
 * Invariants: SLUG_KEBAB (lowercase a-z 0-9 dash, 2-32 chars); RESERVED_SLUGS rejected.
 * Side-effects: none
 * @public
 */

const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;

const RESERVED_SLUGS = new Set(["operator", "resy", "node-template", "poly"]);

export interface ParsedSlug {
  readonly slug: string;
  /** Relative path registered in the operator root repo-spec `nodes:` section. */
  readonly path: string;
}

export function parseNodeSlug(
  input: string
): { ok: true; value: ParsedSlug } | { ok: false; reason: string } {
  const slug = input.trim().toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return {
      ok: false,
      reason:
        "Slug must be 2-32 chars, lowercase letters/numbers/dashes, starting with a letter",
    };
  }
  if (RESERVED_SLUGS.has(slug)) {
    return { ok: false, reason: `'${slug}' is a reserved node slug` };
  }
  return { ok: true, value: { slug, path: `nodes/${slug}` } };
}
