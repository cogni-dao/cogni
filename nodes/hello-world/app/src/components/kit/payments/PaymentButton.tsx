// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/payments/PaymentButton`
 * Purpose: Simple payment button with idle/loading/disabled states.
 * Scope: Presentational button only. Does not contain payment logic or state management.
 * Invariants: Never shows success/error content; loading only during IN_FLIGHT phases (not TERMINAL).
 * Side-effects: none
 * Notes: Part of refactored payment UI; opens PaymentFlowDialog on click.
 * Links: docs/spec/payments-design.md, ~/.claude/plans/floating-stirring-trinket.md
 * @public
 */

import { formatCentsToDollars } from "@cogni/node-shared";
import { Loader2 } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@/components/kit/inputs/Button";

export interface PaymentButtonProps {
  /** Amount in USD cents */
  amountUsdCents: number;

  /** True only during pending phases (not TERMINAL) */
  isInFlight: boolean;

  /** Trigger payment initiation */
  onClick: () => void;

  /** Disable all interactions */
  disabled?: boolean;
}

export function PaymentButton({
  amountUsdCents,
  isInFlight,
  onClick,
  disabled = false,
}: PaymentButtonProps): ReactElement {
  const amountDisplay = formatCentsToDollars(amountUsdCents);

  return (
    <Button
      onClick={onClick}
      disabled={disabled || isInFlight}
      rightIcon={isInFlight ? <Loader2 className="animate-spin" /> : undefined}
      className="w-full"
      size="lg"
    >
      {isInFlight ? "Processing..." : `Pay $${amountDisplay}`}
    </Button>
  );
}
