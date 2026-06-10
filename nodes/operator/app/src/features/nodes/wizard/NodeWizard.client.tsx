// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/NodeWizard.client`
 * Purpose: The always-mounted node-setup shell — persistent rail + status-driven step, morphing
 *   in place so server `router.refresh()` advances the flow without a page reset.
 * Scope: Renders `WizardRail` + the `step-registry` entry for the server-given status inside
 *   `AnimatePresence`. Status (from the server row) is the only cursor — fully resumable.
 * Invariants: No client-held step index; reorder stages by editing `state-machine.ts` only.
 * Side-effects: none (steps own their own IO)
 * Links: ./WizardRail.tsx, ./step-registry.tsx, src/features/nodes/state-machine.ts
 * @public
 */

"use client";

import { AnimatePresence, motion } from "motion/react";
import type { ReactElement } from "react";

import { WIZARD_STEP_REGISTRY } from "./step-registry";
import type { WizardNode } from "./types";
import { WizardRail } from "./WizardRail";

interface Props {
  readonly node: WizardNode;
}

export function NodeWizard({ node }: Props): ReactElement {
  const { Component } = WIZARD_STEP_REGISTRY[node.status];

  return (
    <div className="space-y-6">
      <WizardRail status={node.status} />
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={node.status}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -10 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
        >
          <Component node={node} />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
