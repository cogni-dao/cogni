// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@styles/ui/payments`
 * Purpose: CVA styling factories for payment flow components using semantic tokens.
 * Scope: Provides paymentFlowContainer, paymentFlowStatus, paymentFlowStep factories. Does not contain component logic.
 * Invariants: All classes use semantic tokens (no raw colors/spacing); follows mobile-first responsive patterns.
 * Side-effects: none
 * Notes: Token compliance enforced by ESLint no-raw-colors + CI ripgrep checks.
 * Links: docs/spec/ui-implementation.md, docs/spec/payments-design.md
 * @public
 */

import { cva } from "class-variance-authority";

type PaymentFlowStepStateKey = "pending" | "active" | "complete";

const paymentFlowStepStateVariants = {
  pending: "text-muted-foreground",
  active: "text-primary font-medium",
  complete: "text-foreground",
} satisfies Record<PaymentFlowStepStateKey, string>;

/**
 * Container for payment flow UI states.
 * Layout only - children determine visual presentation.
 */
export const paymentFlowContainer = cva("flex flex-col gap-6", {
  variants: {},
  defaultVariants: {},
});

/**
 * Status card for PENDING phase displaying wallet/chain/verification steps.
 * Uses semantic tokens for background, border, padding, text alignment.
 */
export const paymentFlowStatus = cva(
  "rounded-lg border border-border bg-muted/50 p-6 text-center",
  {
    variants: {},
    defaultVariants: {},
  }
);

/**
 * Individual step indicator within payment flow status.
 * Variants control visual state (pending/active/complete).
 */
export const paymentFlowStep = cva("flex items-center gap-2", {
  variants: {
    state: paymentFlowStepStateVariants,
  },
  defaultVariants: {
    state: "pending",
  },
});
