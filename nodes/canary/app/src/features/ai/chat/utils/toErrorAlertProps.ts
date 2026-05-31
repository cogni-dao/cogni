// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/chat/utils/toErrorAlertProps`
 * Purpose: Map ChatError to ErrorAlert component props.
 * Scope: Feature-internal presenter. Keeps mapping logic out of page.tsx. Does not implement error handling or UI components.
 * Invariants: Pure mapping, no side effects.
 * Side-effects: none
 * Notes: Keep internal to feature; do not export from public.ts
 * Links: ErrorAlert kit component, error.chat.v1.contract
 * @internal
 */

import type { ChatError } from "@cogni/node-contracts";

/**
 * Props interface matching the generic ErrorAlert component.
 * Defined here to avoid component importing contracts.
 */
export interface ErrorAlertProps {
  code: string;
  message: string;
  retryable: boolean;
  blocking: boolean;
  showRetry: boolean;
  showSwitchFree: boolean;
  showAddCredits: boolean;
}

/**
 * Map ChatError to ErrorAlert props.
 *
 * @param error - Structured chat error
 * @param hasFreeModelAvailable - Whether a free model is available to switch to
 */
export function toErrorAlertProps(
  error: ChatError,
  hasFreeModelAvailable: boolean
): ErrorAlertProps {
  const isInsufficientCredits = error.code === "INSUFFICIENT_CREDITS";

  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    blocking: error.blocking,
    showRetry: error.retryable,
    // Always show "Use Free Model" for 402 if free model available
    showSwitchFree: isInsufficientCredits && hasFreeModelAvailable,
    // Show "Add Credits" for 402 when no free model OR as secondary action
    showAddCredits:
      error.suggestedAction === "add_credits" && !hasFreeModelAvailable,
  };
}
