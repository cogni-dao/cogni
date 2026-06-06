// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/hooks/usePaymentFlow`
 * Purpose: Orchestrates USDC payment flow state machine with wagmi + backend.
 * Scope: Manages intent → signature → confirmation → submit → poll cycle. Does not persist state across reloads.
 * Invariants: Single payment at a time; attemptId guard cancels stale async on reset; creditsAdded uses usdCentsToCredits.
 * Side-effects: IO (paymentsClient, wagmi); React state (useReducer, polling).
 * Notes: Implements attemptId pattern to prevent stale async continuations from corrupting state after reset/cancel.
 * Links: docs/spec/payments-design.md
 * @public
 */

"use client";

import type { PaymentFlowState } from "@cogni/node-core";
import { usdCentsToCredits } from "@cogni/node-core";
import { clientLogger, EVENT_NAMES } from "@cogni/node-shared";
import { useCallback, useEffect, useReducer, useRef } from "react";
import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { ERC20_ABI, getTransactionExplorerUrl } from "@/shared/web3";
import { paymentsClient } from "../api/paymentsClient";
import { formatPaymentError } from "../utils/formatPaymentError";
import { mapBackendStatus } from "../utils/mapBackendStatus";

// Re-export types for convenience
export type { PaymentFlowPhase, PaymentFlowState } from "@cogni/node-core";

export interface UsePaymentFlowOptions {
  amountUsdCents: number;
  onSuccess?: (creditsAdded: number) => void;
  onError?: (message: string) => void;
}

export interface UsePaymentFlowReturn {
  state: PaymentFlowState;
  startPayment: () => Promise<void>;
  reset: () => void;
}

// Internal state machine
type InternalState =
  | { phase: "READY" }
  | { phase: "CREATING_INTENT" }
  | {
      phase: "AWAITING_SIGNATURE";
      attemptId: string;
      chainId: number;
      token: string;
      to: string;
      amountRaw: string;
    }
  | {
      phase: "AWAITING_CONFIRMATION";
      attemptId: string;
      chainId: number;
      txHash: string;
    }
  | {
      phase: "SUBMITTING_HASH";
      attemptId: string;
      chainId: number;
      txHash: string;
    }
  | {
      phase: "POLLING_VERIFICATION";
      attemptId: string;
      chainId: number;
      txHash: string;
    }
  | {
      phase: "SUCCESS";
      creditsAdded: number;
      txHash: string;
      chainId: number;
    }
  | {
      phase: "ERROR";
      message: string;
      txHash: string | null;
      chainId: number | null;
    };

type Action =
  | { type: "START_CREATE_INTENT" }
  | {
      type: "INTENT_CREATED";
      attemptId: string;
      chainId: number;
      token: string;
      to: string;
      amountRaw: string;
    }
  | { type: "INTENT_FAILED"; error: string }
  | {
      type: "TX_HASH_RECEIVED";
      attemptId: string;
      chainId: number;
      txHash: string;
    }
  | { type: "TX_CONFIRMED"; attemptId: string; chainId: number; txHash: string }
  | { type: "SUBMIT_STARTED" }
  | { type: "SUBMIT_COMPLETED"; needsPolling: boolean }
  | { type: "SUBMIT_FAILED"; error: string }
  | {
      type: "VERIFICATION_SUCCESS";
      creditsAdded: number;
      txHash: string;
      chainId: number;
    }
  | {
      type: "VERIFICATION_FAILED";
      error: string;
      txHash: string | null;
      chainId: number | null;
    }
  | { type: "RESET" };

function reducer(state: InternalState, action: Action): InternalState {
  switch (action.type) {
    case "START_CREATE_INTENT":
      return { phase: "CREATING_INTENT" };

    case "INTENT_CREATED":
      return {
        phase: "AWAITING_SIGNATURE",
        attemptId: action.attemptId,
        chainId: action.chainId,
        token: action.token,
        to: action.to,
        amountRaw: action.amountRaw,
      };

    case "INTENT_FAILED":
      return {
        phase: "ERROR",
        message: action.error,
        txHash: null,
        chainId: null,
      };

    case "TX_HASH_RECEIVED":
      return {
        phase: "AWAITING_CONFIRMATION",
        attemptId: action.attemptId,
        chainId: action.chainId,
        txHash: action.txHash,
      };

    case "TX_CONFIRMED":
      return {
        phase: "SUBMITTING_HASH",
        attemptId: action.attemptId,
        chainId: action.chainId,
        txHash: action.txHash,
      };

    case "SUBMIT_STARTED":
      return state;

    case "SUBMIT_COMPLETED":
      if (state.phase !== "SUBMITTING_HASH") return state;
      if (action.needsPolling) {
        return {
          phase: "POLLING_VERIFICATION",
          attemptId: state.attemptId,
          chainId: state.chainId,
          txHash: state.txHash,
        };
      }
      // If backend immediately confirmed/failed, state will be updated by next action
      return state;

    case "SUBMIT_FAILED":
      // Preserve txHash/chainId if we have them (for on-chain failures)
      if ("txHash" in state && "chainId" in state) {
        return {
          phase: "ERROR",
          message: action.error,
          txHash: state.txHash,
          chainId: state.chainId,
        };
      }
      return {
        phase: "ERROR",
        message: action.error,
        txHash: null,
        chainId: null,
      };

    case "VERIFICATION_SUCCESS":
      return {
        phase: "SUCCESS",
        creditsAdded: action.creditsAdded,
        txHash: action.txHash,
        chainId: action.chainId,
      };

    case "VERIFICATION_FAILED":
      return {
        phase: "ERROR",
        message: action.error,
        txHash: action.txHash,
        chainId: action.chainId,
      };

    case "RESET":
      return { phase: "READY" };

    default:
      return state;
  }
}

function derivePublicState(internal: InternalState): PaymentFlowState {
  const _isInFlight =
    internal.phase === "CREATING_INTENT" ||
    internal.phase === "AWAITING_SIGNATURE" ||
    internal.phase === "AWAITING_CONFIRMATION" ||
    internal.phase === "SUBMITTING_HASH" ||
    internal.phase === "POLLING_VERIFICATION";

  switch (internal.phase) {
    case "READY":
      return {
        phase: "READY",
        isCreatingIntent: false,
        walletStep: null,
        txHash: null,
        explorerUrl: null,
        isInFlight: false,
        result: null,
        errorMessage: null,
        creditsAdded: null,
      };

    case "CREATING_INTENT":
      return {
        phase: "READY",
        isCreatingIntent: true,
        walletStep: null,
        txHash: null,
        explorerUrl: null,
        isInFlight: true,
        result: null,
        errorMessage: null,
        creditsAdded: null,
      };

    case "AWAITING_SIGNATURE":
      return {
        phase: "PENDING",
        isCreatingIntent: false,
        walletStep: "SIGNING",
        txHash: null,
        explorerUrl: null,
        isInFlight: true,
        result: null,
        errorMessage: null,
        creditsAdded: null,
      };

    case "AWAITING_CONFIRMATION": {
      const { txHash, chainId } = internal;
      return {
        phase: "PENDING",
        isCreatingIntent: false,
        walletStep: "CONFIRMING",
        txHash,
        explorerUrl: getTransactionExplorerUrl(chainId, txHash),
        isInFlight: true,
        result: null,
        errorMessage: null,
        creditsAdded: null,
      };
    }

    case "SUBMITTING_HASH": {
      const { txHash, chainId } = internal;
      return {
        phase: "PENDING",
        isCreatingIntent: false,
        walletStep: "SUBMITTING",
        txHash,
        explorerUrl: getTransactionExplorerUrl(chainId, txHash),
        isInFlight: true,
        result: null,
        errorMessage: null,
        creditsAdded: null,
      };
    }

    case "POLLING_VERIFICATION": {
      const { txHash, chainId } = internal;
      return {
        phase: "PENDING",
        isCreatingIntent: false,
        walletStep: "VERIFYING",
        txHash,
        explorerUrl: getTransactionExplorerUrl(chainId, txHash),
        isInFlight: true,
        result: null,
        errorMessage: null,
        creditsAdded: null,
      };
    }

    case "SUCCESS": {
      return {
        phase: "DONE",
        isCreatingIntent: false,
        walletStep: null,
        txHash: internal.txHash,
        explorerUrl: getTransactionExplorerUrl(
          internal.chainId,
          internal.txHash
        ),
        isInFlight: false,
        result: "SUCCESS",
        errorMessage: null,
        creditsAdded: internal.creditsAdded,
      };
    }

    case "ERROR": {
      return {
        phase: "DONE",
        isCreatingIntent: false,
        walletStep: null,
        txHash: internal.txHash,
        explorerUrl:
          internal.chainId && internal.txHash
            ? getTransactionExplorerUrl(internal.chainId, internal.txHash)
            : null,
        isInFlight: false,
        result: "ERROR",
        errorMessage: internal.message,
        creditsAdded: null,
      };
    }
  }
}

export function usePaymentFlow(
  options: UsePaymentFlowOptions
): UsePaymentFlowReturn {
  const { amountUsdCents, onSuccess, onError } = options;
  const [internalState, dispatch] = useReducer(reducer, { phase: "READY" });

  const { writeContract, data: txHash, error: writeError } = useWriteContract();
  const { data: receipt, error: receiptError } = useWaitForTransactionReceipt({
    hash: txHash,
  });

  // Track callback invocation to avoid double-calls
  const successCalledRef = useRef(false);
  const errorCalledRef = useRef(false);

  // Attempt ID to guard against stale async operations after reset/cancel
  // Incremented on startPayment and reset - stale async checks this before dispatching
  const attemptIdRef = useRef(0);

  // Handle wallet write errors
  useEffect(() => {
    if (writeError && internalState.phase === "AWAITING_SIGNATURE") {
      const formatted = formatPaymentError(writeError);
      // User rejection is expected behavior, not an error
      clientLogger.warn(EVENT_NAMES.CLIENT_PAYMENTS_FLOW_WALLET_WRITE_ERROR, {
        phase: internalState.phase,
        error: formatted.debug,
      });
      dispatch({
        type: "INTENT_FAILED",
        error: formatted.userMessage,
      });
    }
  }, [writeError, internalState.phase]);

  // Handle receipt errors
  useEffect(() => {
    if (receiptError && internalState.phase === "AWAITING_CONFIRMATION") {
      const formatted = formatPaymentError(receiptError);
      clientLogger.error(EVENT_NAMES.CLIENT_PAYMENTS_FLOW_RECEIPT_ERROR, {
        phase: internalState.phase,
        error: formatted.debug,
      });
      dispatch({
        type: "SUBMIT_FAILED",
        error: formatted.userMessage,
      });
    }
  }, [receiptError, internalState.phase]);

  // Handle txHash received
  useEffect(() => {
    if (
      txHash &&
      internalState.phase === "AWAITING_SIGNATURE" &&
      "attemptId" in internalState &&
      "chainId" in internalState
    ) {
      dispatch({
        type: "TX_HASH_RECEIVED",
        attemptId: internalState.attemptId,
        chainId: internalState.chainId,
        txHash,
      });
    }
  }, [txHash, internalState]);

  // Handle receipt confirmed
  useEffect(() => {
    if (
      receipt &&
      internalState.phase === "AWAITING_CONFIRMATION" &&
      "attemptId" in internalState &&
      "chainId" in internalState &&
      "txHash" in internalState
    ) {
      // Capture attemptId at effect start to detect stale async
      const effectAttemptId = attemptIdRef.current;

      dispatch({
        type: "TX_CONFIRMED",
        attemptId: internalState.attemptId,
        chainId: internalState.chainId,
        txHash: internalState.txHash,
      });

      // Submit txHash to backend
      (async () => {
        dispatch({ type: "SUBMIT_STARTED" });

        const result = await paymentsClient.submitTxHash(
          internalState.attemptId,
          { txHash: internalState.txHash }
        );

        // Guard: if attempt was reset during await, ignore result
        if (attemptIdRef.current !== effectAttemptId) {
          return;
        }

        if (!result.ok) {
          dispatch({ type: "SUBMIT_FAILED", error: result.error });
          return;
        }

        // Check if backend immediately resolved (stub verifier case)
        // submitTxHash returns internal backend status (CREATED_INTENT | PENDING_UNVERIFIED | CREDITED | REJECTED | FAILED)
        // At this point, internalState is AWAITING_CONFIRMATION which has non-null txHash and chainId
        if (internalState.phase !== "AWAITING_CONFIRMATION") return;
        const { txHash, chainId } = internalState;

        if (result.data.status === "CREDITED") {
          dispatch({
            type: "VERIFICATION_SUCCESS",
            creditsAdded: Number(usdCentsToCredits(amountUsdCents)),
            txHash,
            chainId,
          });
          dispatch({ type: "SUBMIT_COMPLETED", needsPolling: false });
        } else if (
          result.data.status === "REJECTED" ||
          result.data.status === "FAILED"
        ) {
          dispatch({
            type: "VERIFICATION_FAILED",
            error: result.data.errorMessage ?? "Verification failed",
            txHash,
            chainId,
          });
          dispatch({ type: "SUBMIT_COMPLETED", needsPolling: false });
        } else {
          // PENDING_UNVERIFIED - need to poll
          dispatch({ type: "SUBMIT_COMPLETED", needsPolling: true });
        }
      })();
    }
  }, [receipt, internalState, amountUsdCents]);

  // Polling effect
  useEffect(() => {
    if (
      internalState.phase !== "POLLING_VERIFICATION" ||
      !("attemptId" in internalState)
    ) {
      return;
    }

    // Capture attemptId at effect start to detect stale async
    const effectAttemptId = attemptIdRef.current;
    // Type narrowing: POLLING_VERIFICATION always has non-null txHash and chainId
    const { txHash, chainId, attemptId } = internalState;

    const pollInterval = setInterval(async () => {
      // Guard: if attempt was reset, stop polling
      if (attemptIdRef.current !== effectAttemptId) {
        clearInterval(pollInterval);
        return;
      }

      const result = await paymentsClient.getStatus(attemptId);

      // Guard: check again after await
      if (attemptIdRef.current !== effectAttemptId) {
        return;
      }

      if (!result.ok) {
        dispatch({
          type: "VERIFICATION_FAILED",
          error: result.error,
          txHash,
          chainId,
        });
        return;
      }

      const mapped = mapBackendStatus(
        result.data.status,
        result.data.errorCode
      );

      if (mapped.phase === "DONE") {
        if (mapped.result === "SUCCESS") {
          dispatch({
            type: "VERIFICATION_SUCCESS",
            creditsAdded: Number(usdCentsToCredits(amountUsdCents)),
            txHash,
            chainId,
          });
        } else {
          dispatch({
            type: "VERIFICATION_FAILED",
            error: mapped.errorMessage ?? "Verification failed",
            txHash,
            chainId,
          });
        }
      }
    }, 3000); // Poll every 3 seconds (backend throttles to 10s)

    return () => clearInterval(pollInterval);
  }, [internalState, amountUsdCents]);

  // Success callback
  useEffect(() => {
    if (
      internalState.phase === "SUCCESS" &&
      !successCalledRef.current &&
      onSuccess
    ) {
      successCalledRef.current = true;
      onSuccess(internalState.creditsAdded);
    }
  }, [internalState, onSuccess]);

  // Error callback
  useEffect(() => {
    if (internalState.phase === "ERROR" && !errorCalledRef.current && onError) {
      errorCalledRef.current = true;
      onError(internalState.message);
    }
  }, [internalState, onError]);

  const startPayment = useCallback(async () => {
    if (internalState.phase !== "READY") {
      return;
    }

    // Start new attempt - increment to invalidate any prior stale operations
    attemptIdRef.current += 1;
    const currentAttemptId = attemptIdRef.current;

    dispatch({ type: "START_CREATE_INTENT" });

    const result = await paymentsClient.createIntent({ amountUsdCents });

    // Guard: if attempt was reset/restarted during await, ignore result
    if (attemptIdRef.current !== currentAttemptId) {
      return;
    }

    if (!result.ok) {
      dispatch({ type: "INTENT_FAILED", error: result.error });
      return;
    }

    const { attemptId, chainId, token, to, amountRaw } = result.data;

    dispatch({
      type: "INTENT_CREATED",
      attemptId,
      chainId,
      token,
      to,
      amountRaw,
    });

    // Trigger wallet write
    writeContract({
      chainId,
      address: token as `0x${string}`,
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [to as `0x${string}`, BigInt(amountRaw)],
    });
  }, [internalState.phase, amountUsdCents, writeContract]);

  const reset = useCallback(() => {
    // Invalidate any in-flight async operations from prior attempt
    attemptIdRef.current += 1;
    successCalledRef.current = false;
    errorCalledRef.current = false;
    dispatch({ type: "RESET" });
  }, []);

  return {
    state: derivePublicState(internalState),
    startPayment,
    reset,
  };
}
