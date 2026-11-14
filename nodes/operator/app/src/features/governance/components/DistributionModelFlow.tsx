// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/components/DistributionModelFlow`
 * Purpose: Static, data-free visual of the node's finalize-to-publish-to-claim token distribution model.
 * Scope: Presentational governance component. It explains the invariant flow but displays no
 *   configured policy amounts and performs no IO.
 * Invariants: FINALIZE_THEN_PUBLISH_THEN_CLAIM, DIRECT_EXECUTE_NO_VOTE, PULL_NOT_PUSH, NO_FABRICATED_FIGURES.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/distribution-lifecycle
 * @public
 */

import { ArrowRight, Coins, FileCheck2, WalletCards } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

export function DistributionModelFlow(): ReactElement {
  return (
    <div className="space-y-3">
      <div>
        <p className="font-semibold text-sm">How tokens move each epoch</p>
        <p className="text-muted-foreground text-sm">
          An approver finalizes a frozen cumulative allocation. A scoped
          executor publishes it directly—minting the delta and setting the new
          root, with no proposal or vote. Contributors then claim.
        </p>
      </div>
      <div
        role="img"
        aria-label="Three steps: finalize the frozen epoch allocation; publish directly as a scoped executor by minting the delta and setting the new root, with no proposal or vote; then contributors claim to their wallets"
        className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center"
      >
        <FlowStep
          number="1"
          icon={<FileCheck2 aria-hidden="true" className="h-5 w-5" />}
          title="Finalize"
          detail="Sign the epoch allocation"
        />
        <FlowArrow />
        <FlowStep
          number="2"
          icon={<Coins aria-hidden="true" className="h-5 w-5" />}
          title="Publish"
          detail="Mint delta + set new root"
        />
        <FlowArrow />
        <FlowStep
          number="3"
          icon={<WalletCards aria-hidden="true" className="h-5 w-5" />}
          title="Claim"
          detail="Pull tokens to a wallet"
        />
      </div>
    </div>
  );
}

function FlowStep({
  number,
  icon,
  title,
  detail,
}: {
  number: string;
  icon: ReactNode;
  title: string;
  detail: string;
}): ReactElement {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3 rounded-lg border border-border/60 bg-muted/20 p-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="font-semibold text-sm">
          <span className="text-muted-foreground">{number}. </span>
          {title}
        </p>
        <p className="text-muted-foreground text-xs">{detail}</p>
      </div>
    </div>
  );
}

function FlowArrow(): ReactElement {
  return (
    <ArrowRight
      aria-hidden="true"
      className="mx-auto h-4 w-4 shrink-0 rotate-90 text-muted-foreground sm:rotate-0"
    />
  );
}
