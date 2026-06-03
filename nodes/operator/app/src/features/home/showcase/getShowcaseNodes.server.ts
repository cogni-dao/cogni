// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/showcase/getShowcaseNodes.server`
 * Purpose: Resolve each curated showcase node to a live homepage href for the operator homepage.
 * Scope: Server-only. Reads base domain from env and applies the catalog host convention. Does not
 *   render UI or fetch over the network.
 * Invariants: Host convention mirrors host_for_node() in scripts/ci/lib/image-tags.sh —
 *   primary node → bare base domain; multi-level domain → `<name>-<domain>`; TLD-style → `<name>.<domain>`.
 *   Falls back to an explicit node.url, then to "#" when no base domain is configured.
 * Side-effects: reads env (serverEnv) only.
 * Links: src/features/home/showcase/nodes.data.ts, scripts/ci/lib/image-tags.sh
 * @public
 */

import { serverEnv } from "@/shared/env";

import { SHOWCASE_NODES, type ShowcaseNode } from "./nodes.data";

export interface ResolvedShowcaseNode extends ShowcaseNode {
  /** Live homepage URL, or "#" when no base domain is resolvable. */
  href: string;
}

/** Strip protocol/path from APP_BASE_URL to a bare host, preferring explicit DOMAIN. */
function baseDomain(): string | undefined {
  const env = serverEnv();
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
function hostForNode(name: string, primary: boolean, domain: string): string {
  if (primary) return domain;
  const isMultiLevel = domain.split(".").length >= 3;
  return isMultiLevel ? `${name}-${domain}` : `${name}.${domain}`;
}

function resolveHref(node: ShowcaseNode, domain: string | undefined): string {
  if (node.url) return node.url;
  if (!domain) return "#";
  return `https://${hostForNode(node.name, node.primary ?? false, domain)}`;
}

/** Curated showcase nodes resolved to live hrefs for rendering. */
export function getShowcaseNodes(): readonly ResolvedShowcaseNode[] {
  const domain = baseDomain();
  return SHOWCASE_NODES.map((node) => ({
    ...node,
    href: resolveHref(node, domain),
  }));
}
