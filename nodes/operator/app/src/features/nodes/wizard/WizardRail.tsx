// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/WizardRail`
 * Purpose: Persistent, animated progress spine for the node setup wizard.
 * Scope: Pure presentational. Derives milestones + current index from the canonical
 *   `state-machine` ordering (the single ordering SSOT); animates the fill on status change.
 *   Token-only styling per ui-governance.
 * Side-effects: none
 * Links: src/features/nodes/state-machine.ts (ordering SSOT)
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { motion } from "motion/react";
import type { ReactElement } from "react";

import {
  NODE_PROGRESS_STEPS,
  progressIndexForStatus,
} from "@/features/nodes/state-machine";
import type { NodeStatus } from "@/shared/db/nodes";

interface Props {
  readonly status: NodeStatus;
}

export function WizardRail({ status }: Props): ReactElement {
  const currentIndex = progressIndexForStatus(status);
  const failed = status === "failed";
  const maxIndex = NODE_PROGRESS_STEPS.length - 1;
  const progressValue = failed
    ? 0
    : (Math.min(currentIndex, maxIndex) / maxIndex) * 100;

  return (
    <nav aria-label="Node setup progress" className="w-full">
      <div className="relative px-2 pt-3">
        {/* Track */}
        <div className="absolute top-5 right-2 left-2 h-px bg-border" />
        {/* Animated fill */}
        <motion.div
          className="absolute top-5 left-2 h-px bg-primary"
          initial={false}
          animate={{ width: `calc(${progressValue}% - 0.5rem)` }}
          transition={{ type: "spring", stiffness: 120, damping: 20 }}
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
                    "flex size-4 items-center justify-center rounded-full bg-background",
                    isCurrent && "bg-primary/20"
                  )}
                >
                  <motion.span
                    initial={false}
                    animate={{ scale: isCurrent ? 1.15 : 1 }}
                    transition={{ type: "spring", stiffness: 300, damping: 18 }}
                    className={cn(
                      "block size-3 rounded-full border transition-colors",
                      (isComplete || isCurrent) && "border-primary bg-primary",
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
