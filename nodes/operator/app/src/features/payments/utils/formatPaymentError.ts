// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/payments/utils/formatPaymentError`
 * Purpose: Maps technical payment errors to a structured, user-facing error.
 * Scope: Pure error mapping. Does not handle UI rendering or logging.
 * Invariants:
 *   - Never returns raw technical errors; always a calm title + message + (optional) actionable hint.
 *   - MINIFICATION_SAFE: classification matches the revert-reason/message TEXT, never
 *     `error.constructor.name` (prod bundles mangle class names — the old gate silently fell
 *     through to "Something went wrong"). Backend error codes win first.
 *   - `debug` is for logging only — NEVER render in UI.
 * Side-effects: none
 * Links: docs/spec/payments-design.md, docs/spec/error-handling.md (FAULT_PARTY_BEFORE_BUCKET)
 * @public
 */

import type { PaymentErrorCode } from "@cogni/node-core";

export interface FormattedError {
  code: string;
  /** Short headline in the user's terms. */
  title: string;
  /** One calm sentence explaining what happened. */
  message: string;
  /** Optional concrete next step. */
  hint?: string;
  /** Whether retrying the same action can plausibly succeed. */
  recoverable: boolean;
  /** Original error for logging only — NEVER render in UI. */
  debug?: string;
}

/**
 * Backend (server-verification) error codes → presentation.
 * Stable strings issued by our own API, so matched by code, not text.
 */
const BACKEND_PRESENTATION: Record<
  PaymentErrorCode,
  Omit<FormattedError, "debug">
> = {
  SENDER_MISMATCH: {
    code: "SENDER_MISMATCH",
    title: "Wrong wallet",
    message: "The payment came from a different wallet than the one connected.",
    hint: "Reconnect the wallet you paid from, then try again.",
    recoverable: true,
  },
  INVALID_TOKEN: {
    code: "INVALID_TOKEN",
    title: "Wrong token",
    message: "That payment used the wrong token.",
    hint: "Pay with USDC on Base.",
    recoverable: true,
  },
  INVALID_RECIPIENT: {
    code: "INVALID_RECIPIENT",
    title: "Wrong recipient",
    message: "The payment was sent to the wrong address.",
    recoverable: false,
  },
  INVALID_CHAIN: {
    code: "INVALID_CHAIN",
    title: "Wrong network",
    message: "That payment was made on the wrong network.",
    hint: "Switch your wallet to Base, then try again.",
    recoverable: true,
  },
  INSUFFICIENT_AMOUNT: {
    code: "INSUFFICIENT_AMOUNT",
    title: "Amount too low",
    message: "The payment was below the minimum.",
    recoverable: true,
  },
  INSUFFICIENT_CONFIRMATIONS: {
    code: "INSUFFICIENT_CONFIRMATIONS",
    title: "Almost there",
    message: "The transaction needs a few more confirmations.",
    hint: "Give it a moment — this usually resolves on its own.",
    recoverable: true,
  },
  TX_NOT_FOUND: {
    code: "TX_NOT_FOUND",
    title: "Transaction not found",
    message: "We couldn't find that transaction on-chain yet.",
    hint: "If it just went through, wait a moment and retry.",
    recoverable: true,
  },
  TX_REVERTED: {
    code: "TX_REVERTED",
    title: "Transaction failed",
    message: "The transfer reverted on-chain and no funds moved.",
    hint: "Check your wallet balance, then try again.",
    recoverable: true,
  },
  TOKEN_TRANSFER_NOT_FOUND: {
    code: "TOKEN_TRANSFER_NOT_FOUND",
    title: "No transfer found",
    message: "That transaction didn't include the expected USDC transfer.",
    recoverable: false,
  },
  RECIPIENT_MISMATCH: {
    code: "RECIPIENT_MISMATCH",
    title: "Wrong recipient",
    message: "The payment went to a different address than expected.",
    recoverable: false,
  },
  RECEIPT_NOT_FOUND: {
    code: "RECEIPT_NOT_FOUND",
    title: "Couldn't confirm",
    message: "We couldn't confirm the transaction in time.",
    hint: "If funds left your wallet, contact support with your transaction hash.",
    recoverable: false,
  },
  INTENT_EXPIRED: {
    code: "INTENT_EXPIRED",
    title: "Session expired",
    message: "This payment session timed out before it completed.",
    hint: "Start the payment again.",
    recoverable: true,
  },
  RPC_ERROR: {
    code: "RPC_ERROR",
    title: "Network hiccup",
    message: "We couldn't reach the blockchain to verify the payment.",
    hint: "Try again in a moment.",
    recoverable: true,
  },
};

/** Collect every field that may carry the failure reason into one lowercased haystack. */
function reasonHaystack(error: unknown, debug: string): string {
  const e = error as {
    name?: unknown;
    shortMessage?: unknown;
    details?: unknown;
    reason?: unknown;
    cause?: { reason?: unknown; message?: unknown };
  } | null;
  return [
    debug,
    e?.name,
    e?.shortMessage,
    e?.details,
    e?.reason,
    e?.cause?.reason,
    e?.cause?.message,
  ]
    .filter((v): v is string => typeof v === "string")
    .join(" ")
    .toLowerCase();
}

/**
 * Map a technical payment error to a structured, user-facing error.
 * Priority: backend codes (stable) → revert-reason / message text (minification-safe).
 */
export function formatPaymentError(error: unknown): FormattedError {
  if (!error) {
    return {
      code: "UNKNOWN",
      title: "Payment didn't complete",
      message:
        "Something interrupted the payment before it finished — no funds were moved.",
      hint: "Please try again.",
      recoverable: true,
    };
  }

  const debug = error instanceof Error ? error.message : JSON.stringify(error);

  // 1. Backend error codes (server-issued, stable) win first.
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code: unknown }).code === "string"
  ) {
    const preset =
      BACKEND_PRESENTATION[
        (error as { code: string }).code as PaymentErrorCode
      ];
    if (preset) return { ...preset, debug };
  }

  // 2. Text classification — matches the reason string, NOT error.constructor.name.
  const reason = reasonHaystack(error, debug);

  // User declined in their wallet — expected, not a failure.
  if (
    /user (rejected|denied)|rejected the request|denied (the )?request/.test(
      reason
    )
  ) {
    return {
      code: "USER_REJECTED",
      title: "Payment cancelled",
      message: "You declined the request in your wallet.",
      recoverable: true,
      debug,
    };
  }

  // ERC-20 transfer revert: not enough USDC. Reason says "exceeds balance", not "insufficient".
  if (
    /transfer amount exceeds balance|exceeds balance|erc20: transfer amount/.test(
      reason
    )
  ) {
    return {
      code: "INSUFFICIENT_BALANCE",
      title: "Not enough USDC",
      message: "This wallet doesn't have enough USDC to cover the payment.",
      hint: "Add USDC on Base, then try again.",
      recoverable: true,
      debug,
    };
  }

  // Not enough native ETH to pay gas.
  if (
    /insufficient funds|gas required exceeds|exceeds the balance of the account/.test(
      reason
    )
  ) {
    return {
      code: "INSUFFICIENT_GAS",
      title: "Not enough ETH for gas",
      message: "This wallet needs a little ETH on Base to cover network fees.",
      hint: "Add a small amount of ETH on Base, then try again.",
      recoverable: true,
      debug,
    };
  }

  // Any other on-chain revert / failed simulation.
  if (/reverted|execution reverted|would fail|will fail/.test(reason)) {
    return {
      code: "CONTRACT_REVERTED",
      title: "Payment can't go through",
      message:
        "This transfer would fail on-chain, so we stopped it before any funds moved.",
      hint: "Check your wallet balance and network, then try again.",
      recoverable: true,
      debug,
    };
  }

  // Connectivity.
  if (/network|timeout|timed out|fetch|connection|econnrefused/.test(reason)) {
    return {
      code: "NETWORK_ERROR",
      title: "Connection problem",
      message: "We couldn't reach the network to complete the payment.",
      hint: "Check your connection and try again.",
      recoverable: true,
      debug,
    };
  }

  // Generic — still calm, recoverable, and carries debug for support.
  return {
    code: "UNKNOWN",
    title: "Payment didn't complete",
    message:
      "Something interrupted the payment before it finished — no funds were moved.",
    hint: "Please try again. If it keeps happening, reach out with the details below.",
    recoverable: true,
    debug,
  };
}
