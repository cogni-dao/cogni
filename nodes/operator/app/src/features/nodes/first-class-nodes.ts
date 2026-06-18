// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/first-class-nodes`
 * Purpose: The fixed set of first-class Cogni nodes that exist as registry rows but are NOT
 *   wizard-spawned — `operator` (the hub monorepo) and `node-template` (the fork source). Lets an
 *   RBAC-gated agent be granted + run flight/secrets/sync on them via the operator itself, instead
 *   of a maintainer's personal `gh`.
 * Scope: Pure constant + guards. The registration route inserts these; node-preview-promote skips
 *   them. Their slugs are reserved in `parseNodeSlug`, so they can never enter via the wizard.
 * Invariants: FIRST_CLASS_FIXED_SET (operator + node-template only), SLUG_IS_KEY,
 *   NOT_PREVIEW_PROMOTABLE (own deploy pipelines, never the spawned-node preview tie).
 * Side-effects: none
 * Links: docs/spec/identity-model.md, story.5009, src/app/api/v1/nodes/register/route.ts
 * @public
 */

/** Repo coordinates for each first-class node (identity/ownership anchor — NOT the deploy SSoT). */
export const FIRST_CLASS_NODES = {
  operator: { repoOwner: "cogni-dao", repoName: "cogni" },
  "node-template": { repoOwner: "cogni-dao", repoName: "node-template" },
} as const;

export type FirstClassSlug = keyof typeof FIRST_CLASS_NODES;

export const FIRST_CLASS_NODE_SLUGS: ReadonlySet<string> = new Set(
  Object.keys(FIRST_CLASS_NODES)
);

export function isFirstClassSlug(slug: string): slug is FirstClassSlug {
  return slug in FIRST_CLASS_NODES;
}
