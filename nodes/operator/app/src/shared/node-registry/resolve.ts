// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-registry/resolve`
 * Purpose: Pure node-registry helpers shared across layers — base-domain derivation, the catalog host
 *   convention (host_for_node), and slug-deduped merge of NodeSummary lists.
 * Scope: No IO, no env access — callers pass the base domain. Importable by features AND adapters.
 * Invariants: host convention mirrors host_for_node() in scripts/ci/lib/image-tags.sh — primary →
 *   bare base domain; multi-level domain (≥3 segments) → `<name>-<domain>`; TLD → `<name>.<domain>`.
 *   Explicit url wins; "#" when no base domain. merge keeps the first occurrence per slug.
 * Side-effects: none
 * Links: src/ports/node-registry.port.ts, scripts/ci/lib/image-tags.sh
 * @public
 */

/** Minimal shape needed to resolve a node's href (structurally satisfied by NetworkNode + DB rows). */
export interface NodeHrefInput {
  readonly name: string;
  readonly url?: string | undefined;
  readonly primary?: boolean | undefined;
}

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

/**
 * In-cluster internal Service DNS for a node app, by slug: `http://<slug>-node-app:3000`.
 * The canonical address for a node whose app is placed IN the cluster, mirroring the CSV the
 * DB-less scheduler-worker consumes via COGNI_NODE_ENDPOINTS.
 *
 * NOT a general answer to "where is node X". A node placed on decentralized compute has no such
 * Service (bug.5106) — callers must go through `nodeAppBaseUrl` (./placement.ts) or, at runtime,
 * `NodeAddressPort`, which pick this convention only when the node's DECLARED placement is k3s.
 */
export function internalNodeAppUrl(slug: string): string {
  return `http://${slug}-node-app:3000`;
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

/** Resolve a node's live homepage href, or "#" when no base domain is known. */
export function resolveHref(
  node: NodeHrefInput,
  domain: string | undefined
): string {
  if (node.url) return node.url;
  if (!domain) return "#";
  return `https://${hostForNode(node.name, node.primary ?? false, domain)}`;
}

/**
 * TitleCase a slug for the gallery FALLBACK title when a node has not yet projected an `intent.hook`
 * (e.g. `node-template` → "Node Template", `oss` → "Oss"). The real title is always the node's own hook;
 * this only fills the gap so an un-projected node reads cleanly instead of showing a raw slug.
 */
export function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Merge slug-keyed lists, keeping the first occurrence per slug (curated/bundled entries win). */
export function mergeBySlug<T extends { readonly slug: string }>(
  ...lists: readonly (readonly T[])[]
): readonly T[] {
  const bySlug = new Map<string, T>();
  for (const list of lists) {
    for (const node of list) {
      if (!bySlug.has(node.slug)) bySlug.set(node.slug, node);
    }
  }
  return [...bySlug.values()];
}
