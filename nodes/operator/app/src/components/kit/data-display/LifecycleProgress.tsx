// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/data-display/LifecycleProgress`
 * Purpose: Responsive horizontal checkpoint rail for ordered, read-only lifecycle status.
 * Scope: Stateless kit presentation. Callers derive domain state and keep actions outside the rail.
 * Invariants:
 *   - STATUS_IS_TEXT: every checkpoint names its state; color and glyphs are supplementary.
 *   - PRESENTATIONAL_ONLY: no navigation, actions, hooks, timers, IO, or domain-state derivation.
 *   - MOBILE_FIRST: equal-width columns keep five checkpoints inside a 360px viewport.
 *   - REDUCED_MOTION_SAFE: rendering is static and contains no animation or transition.
 * Side-effects: none
 * Links: src/features/nodes/wizard/WizardRail.tsx, https://node-template.cognidao.org/knowledge/frontend-development
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { Ban, Check, CircleHelp, LockKeyhole } from "lucide-react";
import type { ReactElement } from "react";

export type LifecycleProgressState =
  | "complete"
  | "current"
  | "pending"
  | "locked"
  | "unavailable"
  | "unknown";

export interface LifecycleProgressStep {
  readonly label: string;
  readonly state: LifecycleProgressState;
  /** Additional status context announced by assistive technology. */
  readonly description?: string;
}

export interface LifecycleProgressProps {
  readonly ariaLabel: string;
  readonly steps: readonly LifecycleProgressStep[];
}

const STATE_LABELS: Record<LifecycleProgressState, string> = {
  complete: "Complete",
  current: "Current",
  pending: "Pending",
  locked: "Locked",
  unavailable: "Unavailable",
  unknown: "Unknown",
};

function CheckpointGlyph({
  state,
}: {
  readonly state: LifecycleProgressState;
}): ReactElement {
  if (state === "complete") {
    return <Check aria-hidden="true" className="size-3" />;
  }
  if (state === "locked") {
    return <LockKeyhole aria-hidden="true" className="size-3" />;
  }
  if (state === "unavailable") {
    return <Ban aria-hidden="true" className="size-3" />;
  }
  if (state === "unknown") {
    return <CircleHelp aria-hidden="true" className="size-3" />;
  }
  return <span aria-hidden="true" className="block size-1.5 rounded-full" />;
}

function connectorIsComplete(
  steps: readonly LifecycleProgressStep[],
  index: number
): boolean {
  const previous = steps[index - 1];
  const current = steps[index];
  return (
    previous?.state === "complete" &&
    (current?.state === "complete" || current?.state === "current")
  );
}

/**
 * Ordered lifecycle status. The rail deliberately contains no buttons or links;
 * callers render any authorized action in the corresponding workspace below it.
 */
export function LifecycleProgress({
  ariaLabel,
  steps,
}: LifecycleProgressProps): ReactElement {
  return (
    <nav aria-label={ariaLabel} className="max-w-full overflow-hidden">
      <ol className="relative grid w-full min-w-0 auto-cols-fr grid-flow-col gap-1 px-1 pt-3">
        {steps.map((step, index) => {
          const stateLabel = STATE_LABELS[step.state];
          return (
            <li
              key={`${step.label}-${index}`}
              aria-current={step.state === "current" ? "step" : undefined}
              className="relative flex min-w-0 flex-col items-center text-center"
            >
              {index > 0 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "-left-1/2 absolute top-2.5 right-1/2 h-px",
                    connectorIsComplete(steps, index)
                      ? "bg-primary"
                      : "bg-border"
                  )}
                />
              ) : null}

              <span
                aria-hidden="true"
                className={cn(
                  "relative z-10 flex size-5 items-center justify-center rounded-full border bg-background",
                  step.state === "complete" &&
                    "border-primary bg-primary text-primary-foreground",
                  step.state === "current" &&
                    "border-primary bg-primary/15 text-primary",
                  step.state === "pending" &&
                    "border-border text-muted-foreground",
                  step.state === "locked" &&
                    "border-muted-foreground/40 text-muted-foreground",
                  step.state === "unavailable" &&
                    "border-muted-foreground/40 bg-muted/30 text-muted-foreground",
                  step.state === "unknown" &&
                    "border-warning/60 bg-warning/10 text-warning"
                )}
              >
                <CheckpointGlyph state={step.state} />
              </span>

              <span
                className={cn(
                  "mt-2 w-full min-w-0 break-words text-xs leading-tight",
                  step.state === "current"
                    ? "font-medium text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {step.label}
              </span>
              <span className="mt-1 text-muted-foreground text-xs leading-none">
                {stateLabel}
              </span>
              {step.description ? (
                <span className="sr-only">. {step.description}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
