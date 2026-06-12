// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/SimpleSteps`
 * Purpose: Copy-only wizard steps for the long-tail / terminal statuses.
 * Scope: Presentational placeholders for not-yet-built activation stages (wallet, payments)
 *   plus active/failed terminals. Carry `available:false` semantics — designed "coming soon".
 * Side-effects: none
 * Links: src/features/nodes/wizard/step-registry.tsx, ../StepSection.tsx
 * @public
 */

import type { ReactElement } from "react";

import { Button } from "@/components";

import { LaunchPackCopyButton } from "../LaunchPackCopyButton.client";
import { StepSection } from "../StepSection";
import type { WizardStepProps } from "../types";

export function WalletStep({ node }: WizardStepProps): ReactElement {
  return (
    <StepSection title="Operator wallet">
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Operator wallet is ready. Activating payment rails is the next stage —
          coming soon.
        </p>
        <div className="flex items-center gap-2">
          <Button disabled>Activate payments</Button>
          <LaunchPackCopyButton nodeId={node.id} />
        </div>
      </div>
    </StepSection>
  );
}

export function PaymentsStep(): ReactElement {
  return (
    <StepSection title="Payments">
      <p className="text-muted-foreground text-sm">
        Payments configured. Opening the activation PR is the final step before
        this node goes live — coming soon.
      </p>
    </StepSection>
  );
}

export function ActiveStep(): ReactElement {
  return (
    <StepSection title="Active">
      <p className="text-muted-foreground text-sm">This node is live.</p>
    </StepSection>
  );
}

export function FailedStep({ node }: WizardStepProps): ReactElement {
  return (
    <StepSection title="Setup failed">
      <p className="text-destructive text-sm">
        {node.failureReason ??
          "Bootstrap failed. Re-register the node to start over."}
      </p>
    </StepSection>
  );
}
