// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@components/kit/payments/PaymentFlowDialog`
 * Purpose: Modal dialog for payment flow states (IN_FLIGHT/TERMINAL).
 * Scope: Presentational dialog component. Does not contain payment logic or state management.
 * Invariants: Dismissible when isInFlight OR isTerminal; parent (UsdcPaymentFlow) decides cancel vs close semantics via onClose callback.
 * Side-effects: none
 * Notes: Dialog uses desktop-only pattern; parent handles escape/backdrop logic via dismissible prop derivation.
 * Links: docs/spec/payments-design.md
 * @public
 */

import type { PaymentFlowState } from "@cogni/node-core";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@cogni/node-ui-kit/shadcn/dialog";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import type { ReactElement } from "react";
import { Button } from "@/components/kit/inputs/Button";

export interface PaymentFlowDialogProps {
  /** Dialog open state */
  open: boolean;

  /** True only during pending phases (from state.isInFlight) */
  isInFlight: boolean;

  /** Current wallet step (for IN_FLIGHT states) */
  walletStep: PaymentFlowState["walletStep"];

  /** Transaction hash (when available) */
  txHash: string | null;

  /** Block explorer URL (when txHash available) */
  explorerUrl: string | null;

  /** Result state (SUCCESS/ERROR) */
  result: "SUCCESS" | "ERROR" | null;

  /** User-friendly error message */
  errorMessage: string | null;

  /** Credits added (on success) */
  creditsAdded: number | null;

  /** Reset payment state */
  onReset: () => void;

  /** Close dialog */
  onClose: () => void;
}

function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}

function getStepMessage(walletStep: PaymentFlowState["walletStep"]): string {
  if (walletStep === null) {
    return "Preparing payment...";
  }

  switch (walletStep) {
    case "SIGNING":
      return "Confirm in your wallet...";
    case "CONFIRMING":
      return "Confirming on-chain...";
    case "SUBMITTING":
      return "Submitting to backend...";
    case "VERIFYING":
      return "Verifying payment...";
    default:
      assertNever(walletStep);
  }
}

/** Format credit amount as USD display string. Uses protocol constant (10M credits = $1). */
function formatCreditsAsUsd(credits: number): string {
  const usd = credits / 10_000_000;
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function PaymentFlowDialog({
  open,
  isInFlight,
  walletStep,
  txHash,
  explorerUrl,
  result,
  errorMessage,
  creditsAdded,
  onReset,
  onClose,
}: PaymentFlowDialogProps): ReactElement {
  const isTerminal = result !== null;

  // Dialog is dismissible in all active states (parent decides cancel vs close)
  const dismissible = isInFlight || isTerminal;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen && dismissible) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="sm:max-w-md"
        onEscapeKeyDown={(e) => {
          if (!dismissible) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (!dismissible) {
            e.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {isTerminal ? "Payment" : "Processing Payment"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          {/* IN_FLIGHT state */}
          {isInFlight && (
            <div className="flex flex-col items-center gap-4 py-6">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              {}
              <p className="text-center text-muted-foreground text-sm">
                {getStepMessage(walletStep)}
              </p>

              {/* Transaction link (when available) */}
              {txHash && explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-1 text-primary text-sm hover:underline"
                >
                  <span>View transaction</span>
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </div>
          )}

          {/* SUCCESS state */}
          {isTerminal && result === "SUCCESS" && (
            <>
              <div className="flex flex-col items-center gap-6 py-8">
                <CheckCircle2 className="h-16 w-16 text-success" />
                <p className="font-semibold text-foreground text-xl">
                  {creditsAdded != null
                    ? `${formatCreditsAsUsd(creditsAdded)} added`
                    : "Payment successful"}
                </p>
              </div>

              <div className="flex flex-col gap-2">
                <Button
                  onClick={() => {
                    onReset();
                    onClose();
                  }}
                  size="lg"
                >
                  Done
                </Button>

                {/* Transaction link */}
                {txHash && explorerUrl && (
                  <a
                    href={explorerUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1 text-primary text-sm hover:underline"
                  >
                    <span>View transaction</span>
                    <ExternalLink className="h-4 w-4" />
                  </a>
                )}
              </div>
            </>
          )}

          {/* ERROR state */}
          {isTerminal && result === "ERROR" && (
            <>
              <div className="flex flex-col items-center gap-6 py-8">
                <XCircle className="h-16 w-16 text-destructive" />
                <p className="font-semibold text-foreground text-xl">
                  {errorMessage ?? "Payment failed"}
                </p>
              </div>

              {/* Transaction link (if payment reached on-chain) */}
              {txHash && explorerUrl && (
                <a
                  href={explorerUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center justify-center gap-1 text-primary text-sm hover:underline"
                >
                  <span>View transaction</span>
                  <ExternalLink className="h-4 w-4" />
                </a>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
