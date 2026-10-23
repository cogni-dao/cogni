// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/work/_components/WorkItemScoresRadar`
 * Purpose: Render a work item's do-it-now `scores` as a small SVG radar plus a per-axis legend, its WSJF `rankScore`, and its human/agent queue (story.5111 step 6c).
 * Scope: Pure presentational component. No fetching; axis config mirrors hub `work-item-scores-design`.
 * Invariants:
 *   - OUTWARD_IS_SOONER: every axis points outward; a bigger area means do it sooner.
 *   - ABSENT_IS_NOT_ZERO: a missing axis has no vertex and shows "—"; it is never drawn as 0.
 *   - EV_IS_A_LINK_NOT_HTML: `ev` renders (as the user-facing "justification" link) only as an https anchor href with rel="noopener noreferrer nofollow"; never as markup.
 *   - RANK_FROM_PACKAGE: `rankScore` comes from `@cogni/work-items`, never re-derived here.
 *   - HUMAN_QUEUE_DEFAULT: `agent` < 3 or missing → human queue.
 * Side-effects: none
 * Links: story.5111, hub work-item-scores-design, hub work-item-scores-visual
 * @public
 */

import type { WorkItemDto } from "@cogni/node-contracts";
import { rankScore } from "@cogni/work-items";
import type { ReactElement } from "react";

type Scores = NonNullable<WorkItemDto["scores"]>;

/** The six v0 axes in radar order (hub `work-item-scores-design`). */
export const SCORE_AXES: readonly { id: string; label: string }[] = [
  { id: "goal", label: "Goal value" },
  { id: "time", label: "Time criticality" },
  { id: "unblocks", label: "Unblocks" },
  { id: "ease", label: "Ease" },
  { id: "confidence", label: "Confidence" },
  { id: "agent", label: "Agent-ready" },
];

const MAX = 5;
const SIZE = 240;
const C = SIZE / 2;
const R = 78;
const LABEL_R = R + 14;

/** True when the item carries at least one score axis. */
export function hasScores(scores: WorkItemDto["scores"]): scores is Scores {
  return scores != null && Object.keys(scores).length > 0;
}

/** Human queue unless an `agent` score of 3 or more says an agent can finish it. */
export function scoreQueue(scores: WorkItemDto["scores"]): "agent" | "human" {
  const agent = scores?.agent?.v;
  return agent != null && agent >= 3 ? "agent" : "human";
}

/** Only an absolute https URL may become an href; anything else is dropped. */
export function safeEvidenceHref(ev: string | undefined): string | undefined {
  if (!ev) return undefined;
  try {
    const url = new URL(ev);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Known axes first, then any extra configured axis the item carries. */
function axesFor(scores: Scores): { id: string; label: string }[] {
  const known = new Set(SCORE_AXES.map((a) => a.id));
  const extra = Object.keys(scores)
    .filter((id) => !known.has(id))
    .sort()
    .map((id) => ({ id, label: id }));
  return [...SCORE_AXES, ...extra];
}

function point(i: number, n: number, r: number): [number, number] {
  const angle = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return [C + r * Math.cos(angle), C + r * Math.sin(angle)];
}

const fmt = (xy: [number, number]) => `${xy[0].toFixed(1)},${xy[1].toFixed(1)}`;

export function WorkItemScoresRadar({
  scores,
}: {
  readonly scores: Scores;
}): ReactElement {
  const axes = axesFor(scores);
  const n = axes.length;
  const rank = rankScore(scores);
  const queue = scoreQueue(scores);

  const rings = [1, 2, 3, 4, 5].map((step) =>
    axes.map((_, i) => fmt(point(i, n, (R * step) / MAX))).join(" ")
  );
  // ABSENT_IS_NOT_ZERO: absent axes contribute no vertex at all.
  const present = axes
    .map((a, i) => ({ i, score: scores[a.id] }))
    .filter((p) => p.score !== undefined);
  const shape = present
    .map((p) => fmt(point(p.i, n, (R * (p.score?.v ?? 0)) / MAX)))
    .join(" ");

  return (
    <div className="flex flex-col gap-3" data-testid="work-item-scores">
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <span className="inline-flex items-center gap-1.5 rounded-md bg-muted px-2 py-0.5">
          <span className="text-muted-foreground">Rank score</span>
          <span className="font-medium font-mono" data-testid="rank-score">
            {rank === undefined ? "—" : rank.toFixed(1)}
          </span>
        </span>
        <span
          className="rounded-md bg-muted px-2 py-0.5 font-medium"
          data-testid="score-queue"
        >
          {queue === "agent" ? "Agent queue" : "Human queue"}
        </span>
      </div>

      <svg
        viewBox={`-50 0 ${SIZE + 100} ${SIZE}`}
        className="w-full max-w-xs self-center"
        role="img"
        aria-label="Priority scores radar: a bigger area means do it sooner"
      >
        {rings.map((pts, ri) => (
          <polygon
            key={`ring-${pts}`}
            points={pts}
            fill="none"
            stroke="hsl(var(--border))"
            strokeWidth={ri === rings.length - 1 ? 1.25 : 1}
          />
        ))}
        {axes.map((a, i) => {
          const [x, y] = point(i, n, R);
          const [lx, ly] = point(i, n, LABEL_R);
          const absent = scores[a.id] === undefined;
          const anchor =
            Math.abs(lx - C) < 1 ? "middle" : lx > C ? "start" : "end";
          return (
            <g key={a.id} data-axis={a.id} data-absent={absent || undefined}>
              <line
                x1={C}
                y1={C}
                x2={x}
                y2={y}
                stroke="hsl(var(--border))"
                strokeDasharray={absent ? "3 3" : undefined}
              />
              <text
                x={lx}
                y={ly}
                textAnchor={anchor}
                dominantBaseline="middle"
                fontSize={10}
                fill="hsl(var(--muted-foreground))"
                opacity={absent ? 0.5 : 1}
              >
                {a.label}
              </text>
            </g>
          );
        })}
        {present.length >= 3 && (
          <polygon
            points={shape}
            fill="hsl(var(--chart-1) / 0.15)"
            stroke="hsl(var(--chart-1))"
            strokeWidth={2}
            data-testid="score-shape"
          />
        )}
        {present.map((p) => {
          const [x, y] = point(p.i, n, (R * (p.score?.v ?? 0)) / MAX);
          return (
            <circle
              key={`dot-${axes[p.i]?.id}`}
              cx={x}
              cy={y}
              r={2.5}
              fill="hsl(var(--chart-1))"
            />
          );
        })}
      </svg>

      <ul className="grid grid-cols-1 gap-1 text-xs sm:grid-cols-2">
        {axes.map((a) => {
          const s = scores[a.id];
          const href = safeEvidenceHref(s?.ev);
          return (
            <li
              key={a.id}
              data-axis={a.id}
              className="flex items-center justify-between gap-2 rounded-md px-1.5 py-0.5"
            >
              <span className="text-muted-foreground">{a.label}</span>
              <span className="flex items-center gap-2">
                {href && (
                  <a
                    href={href}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-primary underline underline-offset-2"
                    title={href}
                    aria-label={`${a.label} justification`}
                  >
                    justification
                  </a>
                )}
                <span className="w-5 text-right font-medium font-mono">
                  {s === undefined ? "—" : s.v}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
