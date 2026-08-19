// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/PhaseList`
 * Purpose: Inline vertical checklist for a short, ordered async ceremony.
 * Scope: Presentational. Renders one row per phase with text plus a done/active/pending/error glyph.
 * Invariants: Status is never communicated by color alone; domain state and actions stay in callers.
 * Side-effects: none
 * Links: src/features/nodes/wizard/steps/DaoStep.client.tsx,
 *   src/features/nodes/DistributionsCard.client.tsx
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { ReactElement } from "react";

export type PhaseState = "done" | "active" | "pending" | "error";

export interface Phase {
  readonly label: string;
  readonly state: PhaseState;
  readonly detail?: string;
  readonly href?: string;
}

function PhaseGlyph({ state }: { readonly state: PhaseState }): ReactElement {
  switch (state) {
    case "done":
      return (
        <CheckCircle2 aria-hidden="true" className="size-5 text-success" />
      );
    case "active":
      return (
        <Loader2
          aria-hidden="true"
          className="size-5 animate-spin text-primary"
        />
      );
    case "error":
      return <XCircle aria-hidden="true" className="size-5 text-destructive" />;
    case "pending":
      return (
        <Circle
          aria-hidden="true"
          className="size-5 text-muted-foreground/40"
        />
      );
  }
}

export function PhaseList({
  phases,
}: {
  readonly phases: readonly Phase[];
}): ReactElement {
  return (
    <ol className="space-y-3">
      {phases.map((phase) => (
        <li key={phase.label} className="flex min-w-0 items-start gap-3">
          <span className="mt-0.5 shrink-0">
            <PhaseGlyph state={phase.state} />
          </span>
          <span className="min-w-0 text-sm">
            <span
              className={cn(
                "block",
                phase.state === "pending"
                  ? "text-muted-foreground"
                  : "text-foreground",
                phase.state === "active" && "font-medium"
              )}
            >
              {phase.label}
            </span>
            {phase.detail ? (
              <span className="block break-words text-muted-foreground text-xs">
                {phase.detail}
              </span>
            ) : null}
            {phase.href ? (
              <a
                href={phase.href}
                target="_blank"
                rel="noreferrer"
                className="block break-all text-primary text-xs underline-offset-4 hover:underline"
              >
                View transaction
              </a>
            ) : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
