// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Compact repo-spec-projected node identity mark for operational surfaces. */

import type { NodeOperationsOverview } from "@cogni/node-contracts";
import type { ReactElement } from "react";

import { isBrandImageMark, resolveBrandIcon } from "@/shared/brand/brandIcons";

type NodeBrand = Pick<
  NodeOperationsOverview,
  "title" | "icon" | "thumbnailUrl" | "brandColor"
>;

export function NodeBrandMark({ node }: { node: NodeBrand }): ReactElement {
  const imageUrl = isBrandImageMark(node.icon)
    ? node.icon
    : (node.thumbnailUrl ?? null);

  if (imageUrl) {
    return (
      // biome-ignore lint/performance/noImgElement: node marks are sovereign cross-origin repo-spec assets.
      <img
        src={imageUrl}
        alt={`${node.title} logo`}
        className="size-9 shrink-0 rounded-lg border bg-muted object-contain p-1"
      />
    );
  }

  if (node.icon) {
    const BrandIcon = resolveBrandIcon(node.icon);
    return (
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted">
        <BrandIcon
          className="size-5"
          color={node.brandColor ?? undefined}
          aria-hidden="true"
        />
        <span className="sr-only">{node.title} logo</span>
      </span>
    );
  }

  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted font-semibold text-foreground uppercase">
      {node.title.charAt(0)}
      <span className="sr-only">{node.title} logo</span>
    </span>
  );
}
