// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/components/NodeTile`
 * Purpose: Shared node tile — one clickable card used by the public homepage showcase AND the
 *   authed node-setup list. Handles live nodes (homepage screenshot, external link) and in-formation
 *   nodes (gradient placeholder, status badge, internal setup link) via one view model. The card's
 *   identity (title/tagline/thumbnail/color) is the NODE's own self-description — callers pass it through;
 *   this component never names a node.
 * Scope: Presentational. Callers map their own data (NodeSummary / wizard rows) to NodeTileView.
 * Invariants: token-only styling; the entire tile is one link; a node without a committed screenshot
 *   falls back to a brand-tinted monogram placeholder (never a broken image); external links open in a new
 *   tab. The brand-color monogram tint is the ONLY arbitrary value (a per-node token from the node's own
 *   repo-spec) — applied via an inline CSS custom property, not Tailwind arbitrary classes.
 * Side-effects: none
 * Links: src/features/home/components/NodeShowcase.tsx, src/app/(app)/nodes/page.tsx
 * @public
 */

import Image from "next/image";
import Link from "next/link";
import type { CSSProperties, ReactElement } from "react";

import { Badge, Card } from "@/components";
import { isBrandImageMark, resolveBrandIcon } from "@/shared/brand/brandIcons";

export interface NodeTileView {
  readonly title: string;
  readonly tagline?: string | null | undefined;
  /** Lucide icon NAME from the node's own `intent.brand.icon` — the card mark, rendered big + tinted. */
  readonly icon?: string | null | undefined;
  /** Homepage screenshot; when absent a gradient placeholder is shown. */
  readonly thumbnailUrl?: string | null | undefined;
  /** Node-self-described brand color (CSS color) tinting the monogram placeholder; falls back to a token. */
  readonly brandColor?: string | null | undefined;
  readonly href: string;
  /** External homepage (new tab) vs internal route (same tab). */
  readonly external?: boolean;
  /** Lifecycle badge for in-formation nodes. */
  readonly status?: {
    readonly label: string;
    readonly intent: "default" | "secondary" | "destructive" | "outline";
  } | null;
  /** Live/down probe verdict. When set, a health dot is shown next to the title. */
  readonly health?: "live" | "down" | null | undefined;
}

/** A brand-tinted CSS variable for the monogram wash — only set when the node declared a color. */
function brandStyle(brandColor?: string | null): CSSProperties | undefined {
  return brandColor
    ? ({ "--node-brand": brandColor } as CSSProperties)
    : undefined;
}

function Banner({
  thumbnailUrl,
  title,
  brandColor,
  icon,
}: {
  thumbnailUrl?: string | null | undefined;
  title: string;
  brandColor?: string | null | undefined;
  icon?: string | null | undefined;
}): ReactElement {
  // IDENTITY_IS_REPO_SPEC_PROJECTION: prefer the node's own `intent.brand.icon` —
  // a hosted logo image (e.g. the Cogni brain) OR a Lucide NAME — over a thumbnail
  // or monogram. Both render centered + brand-tinted.
  if (icon) {
    const iconStyle = brandStyle(brandColor);
    const wash = iconStyle
      ? "from-[var(--node-brand)]/20 via-background to-background"
      : "from-primary/15 via-background to-background";
    const BrandIcon = isBrandImageMark(icon) ? null : resolveBrandIcon(icon);
    return (
      <div
        className={`relative flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br ${wash}`}
        style={iconStyle}
      >
        {BrandIcon ? (
          <BrandIcon
            className="size-20 transition-transform group-hover:scale-105"
            color={brandColor ?? undefined}
            strokeWidth={1.5}
            aria-hidden="true"
          />
        ) : (
          <div className="relative h-3/5 w-3/5 transition-transform group-hover:scale-105">
            <Image
              src={icon}
              alt={`${title} logo`}
              fill
              unoptimized
              sizes="(min-width: 1024px) 22vw, (min-width: 640px) 33vw, 60vw"
              className="object-contain"
            />
          </div>
        )}
      </div>
    );
  }
  if (thumbnailUrl) {
    return (
      <Image
        src={thumbnailUrl}
        alt={`${title} homepage`}
        fill
        sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
        // Node thumbnails are SELF-HOSTED on each node's own (often cross-origin, sovereign) domain —
        // not operator-bundled assets. `unoptimized` loads any node domain without a next/image
        // remotePatterns allowlist, so the gallery works for any node host with no per-domain config.
        unoptimized
        className="object-cover object-top transition-transform group-hover:scale-105"
      />
    );
  }
  // No committed screenshot → a brand-tinted monogram placeholder. Intentional, not a gap: a diagonal
  // wash with the node's initial set in a ringed, frosted chip, so a mixed gallery of screenshot-cards
  // and placeholder-cards reads as deliberate rather than broken. When the node declares a brand color it
  // tints the wash via the `--node-brand` custom property (the one legit per-node arbitrary value);
  // otherwise it falls back to the `primary` token.
  const style = brandStyle(brandColor);
  const wash = style
    ? "from-[var(--node-brand)]/25 via-[var(--node-brand)]/10 to-background"
    : "from-primary/25 via-primary/10 to-background";
  const ring = style ? "border-[var(--node-brand)]/30" : "border-primary/30";
  return (
    <div
      className={`relative flex h-full w-full items-center justify-center overflow-hidden bg-gradient-to-br ${wash}`}
      style={style}
    >
      <span
        className={`flex h-16 w-16 items-center justify-center rounded-full border ${ring} bg-background/60 font-bold text-3xl text-foreground/80 uppercase shadow-sm backdrop-blur-sm`}
      >
        {title.charAt(0)}
      </span>
    </div>
  );
}

/** Health dot: success token for live, muted for down. */
function HealthBadge({ health }: { health: "live" | "down" }): ReactElement {
  const live = health === "live";
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
      <span
        className={`inline-block h-2 w-2 rounded-full ${live ? "bg-success" : "bg-muted-foreground/50"}`}
        aria-hidden="true"
      />
      {live ? "live" : "down"}
    </span>
  );
}

export function NodeTile({ node }: { node: NodeTileView }): ReactElement {
  const linkProps = node.external
    ? { target: "_blank", rel: "noopener noreferrer" }
    : {};
  return (
    <Link href={node.href} className="group block rounded-lg" {...linkProps}>
      <Card className="h-full overflow-hidden transition-colors group-hover:border-primary">
        <div className="relative aspect-video w-full overflow-hidden border-border border-b bg-muted">
          <Banner
            thumbnailUrl={node.thumbnailUrl}
            title={node.title}
            brandColor={node.brandColor}
            icon={node.icon}
          />
        </div>
        <div className="space-y-2 p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-semibold text-foreground text-lg">
              {node.title}
            </h3>
            {node.status ? (
              <Badge intent={node.status.intent} size="sm">
                {node.status.label}
              </Badge>
            ) : node.health ? (
              <HealthBadge health={node.health} />
            ) : null}
          </div>
          {node.tagline ? (
            <p className="text-muted-foreground text-sm">{node.tagline}</p>
          ) : null}
        </div>
      </Card>
    </Link>
  );
}
