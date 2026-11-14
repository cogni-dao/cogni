// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-ui-kit/tool-card/tool-chip`
 * Purpose: Inline pill for tool-call title parameters — small mono-friendly chip, optional external link affordance. Shared across all node apps.
 * Scope: Presentational. Used inside ToolCard `title`. Does not own state, does not fetch data, does not depend on `@assistant-ui/react`.
 * Invariants: LINK_OPENS_NEW_TAB — `href` chips render with `target="_blank" rel="noopener noreferrer"`.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/custom-tool-call-renderer
 * @public
 */

"use client";

import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../util/cn";

export interface ToolChipProps {
  readonly children: ReactNode;
  /** Render inner text as monospace (branches, sha, file paths). */
  readonly mono?: boolean | undefined;
  /** External link href. Renders as <a target=_blank>. */
  readonly href?: string | undefined;
  /** Tooltip / full value for truncated chips (e.g., full sha). */
  readonly title?: string | undefined;
  readonly className?: string | undefined;
}

export function ToolChip({
  children,
  mono,
  href,
  title,
  className,
}: ToolChipProps) {
  const base = cn(
    "inline-flex items-center gap-1 rounded border border-border/60 bg-muted/60 px-1.5 py-0.5 text-xs leading-tight",
    mono && "font-mono",
    href
      ? "text-foreground transition-colors hover:bg-muted hover:text-foreground"
      : "text-muted-foreground",
    className
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        title={title}
        className={base}
      >
        {children}
        <ExternalLinkIcon className="size-3 opacity-60" aria-hidden />
      </a>
    );
  }
  return (
    <span title={title} className={base}>
      {children}
    </span>
  );
}
