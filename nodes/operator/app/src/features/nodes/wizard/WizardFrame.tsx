// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/WizardFrame`
 * Purpose: The single bordered wizard container — compact identity header + rail + animated body.
 * Scope: Presentational shell with a stable max-width and min-height so every step is the same
 *   size; the body animates its height between steps so morphs don't reflow the page. Replaces
 *   the prior three-stacked-blocks layout (giant header card + floating rail + step card).
 * Side-effects: none
 * Links: ./WizardRail.tsx, ./NodeWizard.client.tsx
 * @public
 */

"use client";

import { motion } from "motion/react";
import type { ReactElement, ReactNode } from "react";

import type { NodeStatus } from "@/shared/db/nodes";

import { WizardRail } from "./WizardRail";

interface Props {
  readonly title: string;
  readonly statusLabel: string;
  readonly status: NodeStatus;
  readonly children: ReactNode;
}

export function WizardFrame({
  title,
  statusLabel,
  status,
  children,
}: Props): ReactElement {
  return (
    <div className="mx-auto w-full max-w-2xl overflow-hidden rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between gap-3 px-6 pt-5">
        <h2 className="truncate font-bold text-foreground text-xl">{title}</h2>
        <span className="shrink-0 text-muted-foreground text-sm">
          {statusLabel}
        </span>
      </div>

      <div className="px-4 pt-1">
        <WizardRail status={status} />
      </div>

      <motion.div layout className="min-h-72 px-6 pt-6 pb-6">
        {children}
      </motion.div>
    </div>
  );
}
