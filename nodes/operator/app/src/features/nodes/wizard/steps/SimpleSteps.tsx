// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/wizard/steps/SimpleSteps`
 * Purpose: Copy-only wizard steps for the long-tail / terminal statuses.
 * Scope: Presentational steps — the wallet step (deploy the revenue Split) plus active/failed
 *   terminals. The Split-deploy itself lives on the wagmi activation page (`/nodes/payments`).
 * Side-effects: none
 * Links: src/features/nodes/wizard/step-registry.tsx, src/app/(app)/nodes/payments/page.tsx
 * @public
 */

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import { Button } from "@/components";

import { LaunchPackCopyButton } from "../LaunchPackCopyButton.client";
import { StepSection } from "../StepSection";
import type { WizardStepProps } from "../types";

export function WalletStep({ node }: WizardStepProps): ReactElement {
  return (
    <StepSection title="Deploy your revenue Split">
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">
          Your node wallet is ready. Next, deploy a revenue Split on Base — your
          connected wallet signs the transaction and becomes its controller.
          Then you'll activate payments.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button asChild>
            <Link href={`/nodes/payments?nodeId=${node.id}`}>
              Deploy revenue Split
              <ArrowRight className="size-4" />
            </Link>
          </Button>
          <LaunchPackCopyButton nodeId={node.id} />
        </div>
      </div>
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
