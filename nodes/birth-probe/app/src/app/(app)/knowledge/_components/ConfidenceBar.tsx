// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/knowledge/_components/ConfidenceBar`
 * Purpose: Inline visualization of confidence_pct as a thin gradient bar.
 *   The visual rhythm of the knowledge table — every row carries one, so
 *   confidence drift over time becomes immediately scannable in aggregate.
 * Scope: Pure presentation. Does not fetch or mutate.
 * Invariants: 0–100 clamped; null shows the neutral placeholder.
 * Side-effects: none
 * @internal
 */

"use client";

import type { ReactElement } from "react";

interface ConfidenceBarProps {
  readonly value: number | null;
  readonly width?: number;
}

/**
 * Anchors mirror docs/spec/knowledge-syntropy.md:
 *   < 30 muted (draft) · 30–60 warning (candidate) · 60–80 info (established) ·
 *   80–95 success (canonical) · 95+ primary (hardened/factual).
 * All tones use the operator's semantic CSS-var palette (no raw Tailwind colors).
 */
function toneFor(v: number): { fill: string; track: string; label: string } {
  if (v < 30)
    return {
      fill: "bg-muted-foreground/40",
      track: "bg-muted",
      label: "draft",
    };
  if (v < 60)
    return {
      fill: "bg-warning/80",
      track: "bg-warning/10",
      label: "candidate",
    };
  if (v < 80)
    return {
      fill: "bg-info/80",
      track: "bg-info/10",
      label: "established",
    };
  if (v < 95)
    return {
      fill: "bg-success/80",
      track: "bg-success/10",
      label: "canonical",
    };
  return {
    fill: "bg-primary/85",
    track: "bg-primary/10",
    label: "hardened",
  };
}

export function ConfidenceBar({
  value,
  width = 64,
}: ConfidenceBarProps): ReactElement {
  if (value == null) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground text-xs">
        <span
          className="block h-1 rounded-full bg-muted/60"
          style={{ width }}
        />
        <span className="font-mono opacity-60">—</span>
      </span>
    );
  }
  const clamped = Math.max(0, Math.min(100, value));
  const { fill, track, label } = toneFor(clamped);
  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs"
      title={`${label} · ${clamped}%`}
    >
      <span
        className={`relative block h-1 overflow-hidden rounded-full ${track}`}
        style={{ width }}
      >
        <span
          className={`absolute inset-y-0 left-0 ${fill}`}
          style={{ width: `${clamped}%` }}
        />
      </span>
      <span className="w-7 font-mono text-muted-foreground tabular-nums">
        {clamped}
      </span>
    </span>
  );
}
