// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/RelativeTime`
 * Purpose: Human-friendly timestamp rendering for the knowledge views.
 *   Storage stays ISO; this is the human-view projection layer (per
 *   proj.knowledge-syntropy AI_PATH_RETURNS_FULL_ROW invariant —
 *   AI consumers fetch raw, humans see this).
 * Scope: Pure presentation. No I/O.
 * @internal
 */

"use client";

import type { ReactElement } from "react";

const RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const DTF_SAME_YEAR = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
});
const DTF_OTHER_YEAR = new Intl.DateTimeFormat("en", {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/**
 * Format an ISO timestamp as a human-friendly relative string.
 *
 *   < 1 min     → "just now"
 *   < 60 min    → "5 minutes ago"
 *   < 24 hr     → "3 hours ago"
 *   < 7 days    → "2 days ago"
 *   ≥ 7 days    → "May 12" (same year) or "May 12, 2025" (different year)
 *
 * Renders nothing if the input is empty or invalid.
 */
export function formatRelativeTime(iso: string): string {
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return iso;
  const diffMin = Math.floor((Date.now() - ms) / 60_000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return RTF.format(-diffMin, "minute");
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return RTF.format(-diffHr, "hour");
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return RTF.format(-diffDay, "day");
  const d = new Date(ms);
  return (
    d.getFullYear() === new Date().getFullYear()
      ? DTF_SAME_YEAR
      : DTF_OTHER_YEAR
  ).format(d);
}

interface RelativeTimeProps {
  readonly iso: string | null | undefined;
  readonly className?: string;
}

/**
 * Inline `<time>` element rendering the relative form, with the absolute ISO
 * available in the tooltip + as `dateTime` for accessibility.
 */
export function RelativeTime({
  iso,
  className,
}: RelativeTimeProps): ReactElement {
  if (!iso) {
    return (
      <span className={className ?? "text-muted-foreground"}>&mdash;</span>
    );
  }
  return (
    <time
      dateTime={iso}
      title={iso}
      className={className ?? "text-muted-foreground text-xs"}
    >
      {formatRelativeTime(iso)}
    </time>
  );
}
