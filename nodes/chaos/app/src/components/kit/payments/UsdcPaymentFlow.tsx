// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/payments/UsdcPaymentFlow`
 * Purpose: Composed payment flow UI with button, dialog, and status chip.
 * Scope: Renders PaymentButton + PaymentFlowDialog + PaymentStatusChip. Does not contain business logic or API calls.
 * Invariants: Close when txHash null triggers reset; auto-opens on transitions only; userClosedOnChain tracks chip visibility.
 * Side-effects: none
 * Notes: Transition-based auto-open prevents flash loops; phase-aware close decides cancel vs preserve.
 * Links: docs/spec/payments-design.md
 * @public
 */

"use client";

import type { PaymentFlowState } from "@cogni/node-core";
import { cn } from "@cogni/node-ui-kit/util/cn";
import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { PaymentButton } from "./PaymentButton";
import { PaymentFlowDialog } from "./PaymentFlowDialog";
import { PaymentStatusChip } from "./PaymentStatusChip";

export interface UsdcPaymentFlowProps {
  /** Amount in USD cents */
  amountUsdCents: number;

  /** Current flow state from usePaymentFlow */
  state: PaymentFlowState;

  /** Trigger payment initiation */
  onStartPayment: () => void;

  /** Reset to initial state */
  onReset: () => void;

  /** Disable all interactions */
  disabled?: boolean;

  /** Layout className (flex/margin only) */
  className?: string;
}

export function UsdcPaymentFlow({
  amountUsdCents,
  state,
  onStartPayment,
  onReset,
  disabled = false,
  className,
}: UsdcPaymentFlowProps): ReactElement {
  const [isDialogOpen, setIsDialogOpen] = useState(false);

  // Track previous state for transition detection
  const prevIsInFlight = useRef(false);
  const prevResult = useRef<"SUCCESS" | "ERROR" | null>(null);

  // Track if user manually closed dialog while on-chain (show chip instead)
  const [userClosedOnChain, setUserClosedOnChain] = useState(false);

  // Auto-open dialog only on state transitions (not continuously)
  useEffect(() => {
    const becameInFlight = state.isInFlight && !prevIsInFlight.current;
    const gotResult = state.result !== null && prevResult.current === null;

    // Auto-open when becoming in-flight (unless user already closed on-chain)
    if (becameInFlight && !userClosedOnChain) {
      setIsDialogOpen(true);
    }

    // Always show result - user needs to see success/error
    if (gotResult) {
      setIsDialogOpen(true);
    }

    // Update refs after comparison
    prevIsInFlight.current = state.isInFlight;
    prevResult.current = state.result;
  }, [state.isInFlight, state.result, userClosedOnChain]);

  // Reset userClosedOnChain when payment resets to READY
  useEffect(() => {
    if (state.phase === "READY" && !state.isInFlight && state.result === null) {
      setUserClosedOnChain(false);
    }
  }, [state.phase, state.isInFlight, state.result]);

  // Handle dialog close with phase-aware behavior
  const handleDialogClose = () => {
    // No txHash = no on-chain action yet = safe to cancel/reset
    // This covers: creating intent AND wallet prompt (before signing)
    const canCancel = state.isInFlight && state.txHash === null;

    if (canCancel) {
      onReset();
      setIsDialogOpen(false);
      setUserClosedOnChain(false);
      return;
    }

    // On-chain pending (txHash exists): just close, show chip, keep tracking
    if (state.txHash !== null) {
      setUserClosedOnChain(true);
    }
    setIsDialogOpen(false);
  };

  // Show status chip when dialog is closed but payment is in progress with txHash
  const showStatusChip =
    !isDialogOpen &&
    state.isInFlight &&
    state.txHash !== null &&
    state.explorerUrl !== null;

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {/* Payment Button */}
      <PaymentButton
        amountUsdCents={amountUsdCents}
        isInFlight={state.isInFlight}
        onClick={() => {
          onStartPayment();
          setIsDialogOpen(true);
        }}
        disabled={disabled || state.result !== null}
      />

      {/* Status Chip (when dialog closed but payment in progress) */}
      {showStatusChip && state.txHash && state.explorerUrl && (
        <PaymentStatusChip
          txHash={state.txHash}
          explorerUrl={state.explorerUrl}
          onClick={() => setIsDialogOpen(true)}
        />
      )}

      {/* Payment Flow Dialog */}
      <PaymentFlowDialog
        open={isDialogOpen}
        isInFlight={state.isInFlight}
        walletStep={state.walletStep}
        txHash={state.txHash}
        explorerUrl={state.explorerUrl}
        result={state.result}
        errorMessage={state.errorMessage}
        creditsAdded={state.creditsAdded}
        onReset={onReset}
        onClose={handleDialogClose}
      />
    </div>
  );
}
