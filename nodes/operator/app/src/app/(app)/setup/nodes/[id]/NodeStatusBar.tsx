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

import { Progress } from "@/components";
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
  const maxIndex = NODE_PROGRESS_STEPS.length - 1;
  const progressValue = (Math.min(currentIndex, maxIndex) / maxIndex) * 100;

  return (
    <nav aria-label="Node setup progress" className="w-full">
      <div className="relative px-2 pt-3">
        <Progress
          value={failed ? 0 : progressValue}
          className="absolute top-5 right-2 left-2 h-px rounded-none bg-border"
        />
        <ol
          className="relative z-10 grid gap-2"
          style={{
            gridTemplateColumns: `repeat(${NODE_PROGRESS_STEPS.length}, minmax(0, 1fr))`,
          }}
        >
          {NODE_PROGRESS_STEPS.map((step, i) => {
            const isComplete = !failed && i < currentIndex;
            const isCurrent = !failed && i === currentIndex;

            return (
              <li
                key={step.label}
                className="flex min-w-0 flex-col items-center text-center"
              >
                <span
                  aria-current={isCurrent ? "step" : undefined}
                  className={cn(
                    "flex h-4 w-4 items-center justify-center rounded-full bg-background",
                    isCurrent && "bg-primary/20"
                  )}
                >
                  <span
                    className={cn(
                      "block h-3 w-3 rounded-full border transition-colors",
                      isComplete && "border-primary bg-primary",
                      isCurrent && "border-primary bg-primary",
                      !isComplete && !isCurrent && "border-border bg-muted",
                      failed && i === 0 && "border-destructive bg-destructive"
                    )}
                  />
                </span>
                <span
                  className={cn(
                    "mt-2 w-full min-w-0 text-xs leading-tight",
                    isCurrent
                      ? "font-medium text-foreground"
                      : isComplete
                        ? "text-foreground/70"
                        : "text-muted-foreground"
                  )}
                >
                  {step.label}
                </span>
              </li>
            );
          })}
        </ol>
      </div>
    </nav>
  );
}
