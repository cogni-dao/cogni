// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/treasury/components/TreasuryBadge`
 * Purpose: Displays DAO treasury USDC balance in header as clickable link to Aragon DAO app.
 * Scope: Presentation component using useTreasurySnapshot hook. Client-side only. Does not call APIs or perform RPC directly.
 * Invariants: Shows "$ --" on loading/error; no polling (hook handles fetch strategy); links to Aragon DAO assets page when data available.
 * Side-effects: none (pure presentation)
 * Notes: Phase 2: USDC only. Optional stale indicator for RPC timeouts. Links to app.aragon.org based on chainId.
 * Links: docs/spec/onchain-readers.md
 * @public
 */

"use client";

import Link from "next/link";
import type { ReactElement } from "react";
import { useTreasurySnapshot } from "@/features/treasury/hooks/useTreasurySnapshot";
import { getDaoTreasuryUrl } from "@/shared/web3";

/**
 * Formats USDC balance for display (e.g., "3726.42" → "3,726")
 * Strips decimals and formats with commas for readability
 */
function formatBalanceForDisplay(balance: string): string {
  const num = Number.parseFloat(balance);
  if (Number.isNaN(num)) return "--";
  return Math.floor(num).toLocaleString("en-US");
}

/**
 * Treasury badge component for header display.
 * Shows DAO USDC balance with graceful degradation on errors.
 *
 * @returns Treasury badge element
 */
export function TreasuryBadge(): ReactElement {
  const {
    usdcBalance,
    treasuryAddress,
    chainId,
    isLoading,
    error,
    staleWarning,
  } = useTreasurySnapshot();

  // Determine display value
  let displayValue = "--";
  if (!isLoading && !error && usdcBalance !== null) {
    displayValue = formatBalanceForDisplay(usdcBalance);
  }

  // Generate Aragon DAO URL if we have the data
  const explorerUrl =
    treasuryAddress && chainId
      ? getDaoTreasuryUrl(chainId, treasuryAddress)
      : null;

  // Optional: Add visual indicator for stale data
  const textStyle = staleWarning ? "opacity-60" : "";

  const content = (
    <>
      <span className="text-muted-foreground">Treasury</span>
      <span className={`font-mono font-semibold ${textStyle}`}>
        $ {displayValue}
      </span>
    </>
  );

  // If we have an explorer URL, render as link; otherwise plain div
  if (explorerUrl) {
    return (
      <Link
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm transition-colors hover:bg-accent"
        title={
          staleWarning
            ? "Treasury balance unavailable (RPC timeout) - Click to view on Aragon"
            : "DAO Treasury Balance - Click to view on Aragon"
        }
      >
        {content}
      </Link>
    );
  }

  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-sm"
      title={
        staleWarning
          ? "Treasury balance unavailable (RPC timeout)"
          : "DAO Treasury Balance"
      }
    >
      {content}
    </div>
  );
}
