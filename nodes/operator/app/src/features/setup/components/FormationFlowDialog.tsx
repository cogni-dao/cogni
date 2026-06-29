// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/setup/components/FormationFlowDialog`
 * Purpose: Modal dialog for DAO formation flow states (IN_FLIGHT/TERMINAL).
 * Scope: Presentational dialog component. Mirrors PaymentFlowDialog pattern. Does not contain business logic or state management.
 * Invariants: Dismissible when in-flight (no txHash) or terminal; parent handles reset.
 * Side-effects: none
 * Links: docs/spec/node-formation.md
 * @public
 */

import {
  getDaoUrl,
  getTransactionExplorerUrl,
  toUiError,
} from "@cogni/node-shared";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import type { ReactElement } from "react";
import { useChainId } from "wagmi";
import { Button } from "@/components/kit/inputs/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/kit/overlays/Dialog";
import type {
  FormationPhase,
  VerifiedAddresses,
} from "@/features/setup/daoFormation/formation.reducer";

export interface FormationFlowDialogProps {
  open: boolean;
  phase: FormationPhase;
  daoTxHash: string | null;
  signalTxHash: string | null;
  errorMessage: string | null;
  addresses: VerifiedAddresses | null;
  tokenName: string | null;
  isInFlight: boolean;
  isTerminal: boolean;
  onClose: () => void;
  onReset: () => void;
}

function getPhaseMessage(phase: FormationPhase): string {
  switch (phase) {
    case "IDLE":
      return "Ready to create DAO";
    case "PREFLIGHT":
      return "Checking network configuration...";
    case "CREATING_DAO":
      return "Confirm DAO creation in your wallet...";
    case "AWAITING_DAO_CONFIRMATION":
      return "Confirming DAO transaction...";
    case "DEPLOYING_SIGNAL":
      return "Confirm signal deployment in your wallet...";
    case "AWAITING_SIGNAL_CONFIRMATION":
      return "Confirming signal transaction...";
    case "VERIFYING":
      return "Verifying on-chain results...";
    case "SUCCESS":
      return "DAO verified successfully";
    case "ERROR":
      return "Formation failed";
  }
}

/**
 * Error state content with user-friendly message and optional details.
 */
function ErrorStateContent({
  errorMessage,
  displayTxHash,
  explorerUrl,
  onReset,
}: {
  errorMessage: string | null;
  displayTxHash: string | null;
  explorerUrl: string | null;
  onReset: () => void;
}): ReactElement {
  const uiError = toUiError(errorMessage);

  return (
    <>
      <div className="flex flex-col items-center gap-4 py-8">
        <XCircle className="h-16 w-16 text-destructive" />
        <p className="font-semibold text-foreground text-xl">
          Formation Failed
        </p>
        <p className="max-w-full break-words text-center text-muted-foreground text-sm">
          {uiError.message}
        </p>
      </div>

      {/* Expandable details for debugging */}
      {uiError.detail && (
        <details className="w-full">
          <summary className="cursor-pointer text-muted-foreground text-xs hover:text-foreground">
            Show details
          </summary>
          <pre className="mt-2 max-h-32 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted p-2 font-mono text-xs">
            {uiError.detail}
          </pre>
        </details>
      )}

      <div className="flex flex-col gap-2">
        <Button onClick={onReset} size="lg">
          Try Again
        </Button>

        {/* Transaction link (if formation reached on-chain) */}
        {displayTxHash && explorerUrl && (
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
  );
}

export function FormationFlowDialog({
  open,
  phase,
  daoTxHash,
  signalTxHash,
  errorMessage,
  addresses,
  tokenName,
  isInFlight,
  isTerminal,
  onClose,
  onReset,
}: FormationFlowDialogProps): ReactElement {
  const chainId = useChainId();

  // Determine which txHash to show (signal if available, else dao)
  const displayTxHash = signalTxHash ?? daoTxHash;
  const explorerUrl = displayTxHash
    ? getTransactionExplorerUrl(chainId, displayTxHash)
    : null;
  const daoUrl = addresses?.dao ? getDaoUrl(chainId, addresses.dao) : null;

  // Dialog is dismissible in active states (parent decides cancel vs close)
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
            {isTerminal ? "DAO Formation" : "Creating DAO"}
          </DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          {/* IN_FLIGHT state */}
          {isInFlight && (
            <div className="flex flex-col items-center gap-4 py-6">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <p className="text-center text-muted-foreground text-sm">
                {getPhaseMessage(phase)}
              </p>

              {/* Transaction link (when available) */}
              {displayTxHash && explorerUrl && (
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
          {isTerminal && phase === "SUCCESS" && (
            <>
              <div className="flex flex-col items-center gap-6 py-8">
                <CheckCircle2 className="h-16 w-16 text-success" />
                <div className="text-center">
                  <p className="font-semibold text-foreground text-xl">
                    DAO Verified
                  </p>
                  {tokenName && (
                    <p className="mt-1 text-muted-foreground">{tokenName}</p>
                  )}
                </div>
                {addresses && (
                  <div className="w-full space-y-2 rounded-md bg-muted p-4 font-mono text-xs">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">DAO:</span>
                      <span className="ml-2 truncate">{addresses.dao}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Token:</span>
                      <span className="ml-2 truncate">{addresses.token}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Plugin:</span>
                      <span className="ml-2 truncate">{addresses.plugin}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Signal:</span>
                      <span className="ml-2 truncate">{addresses.signal}</span>
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-col gap-2">
                {/* Primary action: View on Aragon */}
                {daoUrl && (
                  <Button asChild size="lg">
                    <a href={daoUrl} target="_blank" rel="noopener noreferrer">
                      View on Aragon
                      <ExternalLink className="ml-2 h-4 w-4" />
                    </a>
                  </Button>
                )}

                <Button
                  onClick={() => {
                    onReset();
                  }}
                  variant={daoUrl ? "outline" : "default"}
                  size="lg"
                >
                  Done
                </Button>

                {/* Transaction link */}
                {displayTxHash && explorerUrl && (
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
          {isTerminal && phase === "ERROR" && (
            <ErrorStateContent
              errorMessage={errorMessage}
              displayTxHash={displayTxHash}
              explorerUrl={explorerUrl}
              onReset={onReset}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
