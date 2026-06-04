// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/showcase/nodes.resolve`
 * Purpose: Pure resolution of showcase nodes to live homepage hrefs via the catalog host convention.
 * Scope: No IO, no env access — callers pass the base domain. Keeps the host-mapping logic testable in
 *   isolation from server env wiring.
 * Invariants: Host convention mirrors host_for_node() in scripts/ci/lib/image-tags.sh —
 *   primary node → bare base domain; multi-level domain (≥3 segments) → `<name>-<domain>`;
 *   TLD-style → `<name>.<domain>`. Explicit `node.url` wins; "#" when no base domain is known.
 * Side-effects: none
 * Links: src/features/home/showcase/getShowcaseNodes.server.ts, scripts/ci/lib/image-tags.sh
 * @public
 */

import type { ShowcaseNode } from "./nodes.data";

/** Resolve a base domain from env-shaped input: explicit DOMAIN wins, else APP_BASE_URL's host. */
export function baseDomain(env: {
  DOMAIN?: string | undefined;
  APP_BASE_URL?: string | undefined;
}): string | undefined {
  if (env.DOMAIN) return env.DOMAIN;
  if (env.APP_BASE_URL) {
    try {
      return new URL(env.APP_BASE_URL).host;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** Port of host_for_node(): primary serves the base domain; others prefix by convention. */
export function hostForNode(
  name: string,
  primary: boolean,
  domain: string
): string {
  if (primary) return domain;
  const isMultiLevel = domain.split(".").length >= 3;
  return isMultiLevel ? `${name}-${domain}` : `${name}.${domain}`;
}

/** Resolve a single node's live href. */
export function resolveHref(
  node: ShowcaseNode,
  domain: string | undefined
): string {
  if (node.url) return node.url;
  if (!domain) return "#";
  return `https://${hostForNode(node.name, node.primary ?? false, domain)}`;
}
