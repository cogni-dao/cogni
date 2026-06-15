// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/NodeWizard.client`
 * Purpose: The always-mounted node-setup shell — one bordered WizardFrame whose body morphs to the
 *   status-driven step in place, so server `router.refresh()` advances the flow without a page reset.
 * Scope: Renders `WizardFrame` (identity + rail + animated body) + the `step-registry` entry for the
 *   server-given status inside `AnimatePresence`. Status (from the server row) is the only cursor.
 * Invariants: No client-held step index; reorder stages by editing `state-machine.ts` only.
 * Side-effects: none (steps own their own IO)
 * Links: ./WizardFrame.tsx, ./step-registry.tsx, src/features/nodes/state-machine.ts
 * @public
 */

"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactElement } from "react";

import { WIZARD_STEP_REGISTRY } from "./step-registry";
import type { WizardNode } from "./types";
import { WizardFrame } from "./WizardFrame";

interface Props {
  readonly node: WizardNode;
  readonly statusLabel: string;
}

export function NodeWizard({ node, statusLabel }: Props): ReactElement {
  const { Component } = WIZARD_STEP_REGISTRY[node.status];

  return (
    <WizardFrame
      title={node.slug}
      statusLabel={statusLabel}
      status={node.status}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={node.status}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
        >
          <Component node={node} />
        </motion.div>
      </AnimatePresence>
    </WizardFrame>
  );
}
