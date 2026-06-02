// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/credits/CreditsPage.client`
 * Purpose: Client-side credits page UI handling balance display and USDC payment flow.
 * Scope: Fetches credits data via React Query, renders native USDC payment flow, and refreshes balance on success. Does not handle backend payment verification or wallet connection.
 * Invariants: Payment amounts stored as integer cents (no float math).
 * Side-effects: IO (fetch API via React Query).
 * Links: docs/spec/payments-design.md
 * @public
 */

"use client";

import { isValidAmountInput, parseDollarsToCents } from "@cogni/node-shared";
import { useQueryClient } from "@tanstack/react-query";
import { Info } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import {
  Card,
  HintText,
  PageContainer,
  SectionCard,
  SplitInput,
  UsdcPaymentFlow,
} from "@/components";
import {
  creditsToUsd,
  useCreditsSummary,
  usePaymentFlow,
} from "@/features/payments/public";

function formatDollars(credits: number): string {
  const dollars = creditsToUsd(credits);
  return dollars.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function CreditsPageClient(): ReactElement {
  const [amountInput, setAmountInput] = useState<string>("");
  const queryClient = useQueryClient();

  const summaryQuery = useCreditsSummary({ limit: 1 });

  // Parse amount using string-to-cents utility (no float math)
  const amountCents = parseDollarsToCents(amountInput);
  const isValidAmount = amountCents !== null;

  const paymentFlow = usePaymentFlow({
    amountUsdCents: amountCents ?? 200, // Default to $2.00 if invalid
    onSuccess: () => {
      // Refetch balance but DON'T clear amount (would unmount dialog)
      void queryClient.invalidateQueries({
        queryKey: ["payments-summary", { limit: 1 }],
      });
    },
  });

  // Wrap reset to also clear amount (called from "Done" button)
  const handleResetAndClear = () => {
    paymentFlow.reset();
    setAmountInput(""); // Clear after user acknowledges success
  };

  const balance = summaryQuery.data?.balanceCredits ?? 0;
  const balanceDisplay = summaryQuery.isLoading ? "—" : formatDollars(balance);
  const isNegative = balance < 0;

  return (
    <PageContainer maxWidth="2xl">
      {/* Balance Card */}
      <Card className="flex items-center justify-between p-6">
        <span
          className={`font-bold text-4xl ${isNegative ? "text-destructive" : ""}`}
        >
          $ {balanceDisplay}
        </span>
      </Card>

      {/* Buy Credits Section */}
      <SectionCard title="Buy Credits">
        <SplitInput
          label="Amount"
          value={amountInput}
          onChange={(val) => {
            // Allow typing: digits with optional decimal and up to 2 decimal places
            if (isValidAmountInput(val)) {
              setAmountInput(val);
            }
          }}
          placeholder="2.00 - 100000.00"
          disabled={
            // Lock input when: on-chain tx exists OR terminal state (requires explicit reset)
            paymentFlow.state.txHash !== null ||
            paymentFlow.state.result !== null
          }
        />

        {/* Payment Flow */}
        {isValidAmount ? (
          <UsdcPaymentFlow
            amountUsdCents={amountCents}
            state={paymentFlow.state}
            onStartPayment={paymentFlow.startPayment}
            onReset={handleResetAndClear}
            disabled={summaryQuery.isLoading}
          />
        ) : (
          <button
            type="button"
            disabled
            className="w-full cursor-not-allowed rounded-md bg-muted px-4 py-2 text-muted-foreground"
          >
            Invalid amount
          </button>
        )}

        <HintText icon={<Info size={16} />}>
          Transactions may take many minutes to confirm
        </HintText>
      </SectionCard>
    </PageContainer>
  );
}
