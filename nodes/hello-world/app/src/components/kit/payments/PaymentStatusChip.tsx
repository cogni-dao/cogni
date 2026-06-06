// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/payments/PaymentStatusChip`
 * Purpose: Compact indicator for background payment processing.
 * Scope: Shows "Payment in progress" with tx link when dialog is closed but payment active. Does not contain payment logic.
 * Invariants: Only visible when txHash exists and dialog is closed; clicking reopens dialog.
 * Side-effects: none
 * Notes: Part of refactored payment UI; allows users to close dialog but still monitor payment.
 * Links: docs/spec/payments-design.md, ~/.claude/plans/floating-stirring-trinket.md
 * @public
 */

import { cn } from "@cogni/node-ui-kit/util/cn";
import { ExternalLink, Loader2 } from "lucide-react";
import type { ReactElement } from "react";

export interface PaymentStatusChipProps {
  /** Transaction hash */
  txHash: string;

  /** Block explorer URL */
  explorerUrl: string;

  /** Reopen dialog */
  onClick: () => void;
}

export function PaymentStatusChip({
  explorerUrl,
  onClick,
}: PaymentStatusChipProps): ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full items-center justify-between rounded-md border border-border bg-muted px-4 py-3",
          "text-muted-foreground text-sm hover:bg-muted/80"
        )}
      >
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>Payment in progress</span>
        </div>
        <span className="text-primary text-xs">View details →</span>
      </button>

      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center justify-center gap-1 text-primary text-xs hover:underline"
        onClick={(e) => e.stopPropagation()} // Don't trigger chip click
      >
        <span>View transaction</span>
        <ExternalLink className="h-3 w-3" />
      </a>
    </div>
  );
}
