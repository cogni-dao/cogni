// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/nodes/components/nodeTileView`
 * Purpose: Single NodeSummary → NodeTileView mapper used by public and authed node galleries.
 * Scope: Pure presentation mapping. Does not fetch registry rows or owner-scoped node rows.
 * Invariants: Node identity fields come from NodeSummary, which is the repo-spec/well-known projection.
 * Side-effects: none
 * Links: src/features/nodes/components/NodeTile.tsx, src/ports/node-registry.port.ts
 * @public
 */

import type { NodeSummary } from "@/ports";

import type { NodeTileView } from "./NodeTile";

type StatusView = NonNullable<NodeTileView["status"]>;

export interface NodeTileViewOptions {
  readonly href?: string | undefined;
  readonly external?: boolean | undefined;
  readonly status?: StatusView | null | undefined;
  readonly density?: NodeTileView["density"] | undefined;
}

/** Prefer the repo-spec mission blurb when present; fall back to the short hook. */
function displayBlurb(node: NodeSummary): string | undefined {
  const mission = node.mission?.trim();
  if (mission) return mission;
  const tagline = node.tagline.trim();
  return tagline || undefined;
}

export function nodeSummaryToTileView(
  node: NodeSummary,
  options: NodeTileViewOptions = {}
): NodeTileView {
  const tagline = displayBlurb(node);
  return {
    title: node.title,
    href: options.href ?? node.href,
    ...(tagline !== undefined && { tagline }),
    ...(node.icon !== undefined && { icon: node.icon }),
    ...(node.thumbnailUrl !== undefined && { thumbnailUrl: node.thumbnailUrl }),
    ...(node.brandColor !== undefined && { brandColor: node.brandColor }),
    ...(options.external !== undefined && { external: options.external }),
    ...(options.status !== undefined && { status: options.status }),
    ...(node.health !== undefined && { health: node.health }),
    ...(options.density !== undefined && { density: options.density }),
  };
}
