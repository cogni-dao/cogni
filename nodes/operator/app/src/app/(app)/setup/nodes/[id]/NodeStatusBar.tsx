// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/nodes/[id]/NodeStatusBar`
 * Purpose: Horizontal dot-line-dot progress header for the node setup wizard.
 * Scope: Pure presentational. Maps a NodeStatus to the governance-only milestones; `failed` renders an error tint.
 *   Token-only styling (no raw colors) per ui-governance.
 * Side-effects: none
 * Links: src/features/nodes/state-machine.ts, task.5083
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ReactElement } from "react";

import {
  NODE_PROGRESS_STEPS,
  progressIndexForStatus,
} from "@/features/nodes/state-machine";
import type { NodeStatus } from "@/shared/db/nodes";

interface Props {
  readonly status: NodeStatus;
}

export function NodeStatusBar({ status }: Props): ReactElement {
  const currentIndex = progressIndexForStatus(status);
  const failed = status === "failed";

  return (
    <nav
      aria-label="Node setup progress"
      className="flex w-full items-start justify-between"
    >
      {NODE_PROGRESS_STEPS.map((step, i) => {
        const isComplete = !failed && i < currentIndex;
        const isCurrent = !failed && i === currentIndex;
        const isLast = i === NODE_PROGRESS_STEPS.length - 1;

        return (
          <div
            key={step.status}
            className="flex flex-1 flex-col items-center last:flex-none"
          >
            <div className="flex w-full items-center">
              {/* leading line (hidden on first) */}
              {i > 0 ? (
                <span
                  aria-hidden
                  className={cn(
                    "h-px flex-1",
                    i <= currentIndex && !failed ? "bg-primary" : "bg-border"
                  )}
                />
              ) : (
                <span aria-hidden className="flex-1" />
              )}

              {/* dot — current step wears a token-tinted halo (no ring utilities) */}
              <span
                aria-current={isCurrent ? "step" : undefined}
                className={cn(
                  "flex shrink-0 items-center justify-center rounded-full",
                  isCurrent ? "bg-primary/20 p-1" : "p-0"
                )}
              >
                <span
                  className={cn(
                    "h-3 w-3 rounded-full border transition-colors",
                    isComplete && "border-primary bg-primary",
                    isCurrent && "border-primary bg-primary",
                    !isComplete && !isCurrent && "border-border bg-muted",
                    failed && i === 0 && "border-destructive bg-destructive"
                  )}
                />
              </span>

              {/* trailing line (hidden on last) */}
              {!isLast ? (
                <span
                  aria-hidden
                  className={cn(
                    "h-px flex-1",
                    i < currentIndex && !failed ? "bg-primary" : "bg-border"
                  )}
                />
              ) : (
                <span aria-hidden className="flex-1" />
              )}
            </div>

            <span
              className={cn(
                "mt-2 text-center text-xs",
                isCurrent
                  ? "font-medium text-foreground"
                  : isComplete
                    ? "text-foreground/70"
                    : "text-muted-foreground"
              )}
            >
              {step.label}
            </span>
          </div>
        );
      })}
    </nav>
  );
}
