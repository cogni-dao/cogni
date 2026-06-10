// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/PhaseList`
 * Purpose: Inline vertical phase checklist for long async flows (DAO formation, repo publish).
 * Scope: Presentational. Renders one row per phase with a done/active/pending/error glyph.
 *   Replaces screen-blocking modals with in-place progressive disclosure.
 * Side-effects: none
 * Links: src/features/nodes/wizard/steps/DaoStep.client.tsx, .../RepoStep.client.tsx
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import type { ReactElement } from "react";

export type PhaseState = "done" | "active" | "pending" | "error";

export interface Phase {
  readonly label: string;
  readonly state: PhaseState;
}

function PhaseGlyph({ state }: { state: PhaseState }): ReactElement {
  switch (state) {
    case "done":
      return <CheckCircle2 className="size-5 text-success" />;
    case "active":
      return <Loader2 className="size-5 animate-spin text-primary" />;
    case "error":
      return <XCircle className="size-5 text-destructive" />;
    case "pending":
      return <Circle className="size-5 text-muted-foreground/40" />;
  }
}

export function PhaseList({
  phases,
}: {
  phases: readonly Phase[];
}): ReactElement {
  return (
    <ol className="space-y-3">
      {phases.map((phase) => (
        <li key={phase.label} className="flex items-center gap-3">
          <PhaseGlyph state={phase.state} />
          <span
            className={cn(
              "text-sm",
              phase.state === "pending"
                ? "text-muted-foreground"
                : "text-foreground",
              phase.state === "active" && "font-medium"
            )}
          >
            {phase.label}
          </span>
        </li>
      ))}
    </ol>
  );
}
