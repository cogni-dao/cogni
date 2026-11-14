// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/lib/tokenomics-visuals`
 * Purpose: Pure presentation models for honest token issuance and attribution-credit visuals.
 * Scope: Derives disjoint on-chain supply slices and a bounded top-five credit ranking. No IO,
 *   React, wallet reads, or token/credit conversion.
 * Invariants:
 *   - TOKENS_ARE_NOT_CREDITS: token supply and attribution credits never share a calculation.
 *   - ISSUANCE_CONSERVATION: available issuance slices sum exactly to totalSupply.
 *   - ATTRIBUTION_IS_NOT_OWNERSHIP: credit shares describe finalized attribution only.
 *   - ALL_MATH_BIGINT: source amounts remain bigint until a bounded display percentage is derived.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/tokenomics-budget-policy, https://node-template.cognidao.org/knowledge/distribution-lifecycle
 * @public
 */

export type IssuanceSplit =
  | {
      readonly kind: "available";
      readonly totalSupply: bigint;
      readonly distributorBalance: bigint;
      readonly walletsElsewhereBalance: bigint;
      readonly distributorPercent: number;
      readonly walletsElsewherePercent: number;
    }
  | {
      /** Separate chain reads can briefly disagree across blocks; never draw a false split. */
      readonly kind: "inconsistent";
      readonly totalSupply: bigint;
      readonly distributorBalance: bigint;
    };

/**
 * Build the current issued-supply split. Returns null until both reads exist.
 * Percentages are display-only hundredths and therefore bounded to safe numbers.
 */
export function buildIssuanceSplit(
  totalSupply: bigint | undefined,
  distributorBalance: bigint | undefined
): IssuanceSplit | null {
  if (totalSupply === undefined || distributorBalance === undefined)
    return null;
  if (distributorBalance > totalSupply) {
    return { kind: "inconsistent", totalSupply, distributorBalance };
  }

  const walletsElsewhereBalance = totalSupply - distributorBalance;
  if (totalSupply === 0n) {
    return {
      kind: "available",
      totalSupply,
      distributorBalance,
      walletsElsewhereBalance,
      distributorPercent: 0,
      walletsElsewherePercent: 0,
    };
  }

  const distributorBasisPoints = Number(
    (distributorBalance * 10_000n) / totalSupply
  );
  const distributorPercent = distributorBasisPoints / 100;

  return {
    kind: "available",
    totalSupply,
    distributorBalance,
    walletsElsewhereBalance,
    distributorPercent,
    walletsElsewherePercent: 100 - distributorPercent,
  };
}

export interface AttributionCreditInput {
  readonly claimantKey: string;
  readonly displayName: string | null;
  readonly claimantLabel: string;
  readonly totalCredits: string;
}

export interface AttributionCreditBar {
  readonly key: string;
  readonly label: string;
  readonly totalCredits: string;
  readonly sharePercent: number;
  readonly isOther: boolean;
}

const MAX_NAMED_CREDIT_BARS = 5;

/** Top five contributors plus one exact aggregate for every remaining contributor. */
export function buildAttributionCreditBars(
  holdings: readonly AttributionCreditInput[]
): readonly AttributionCreditBar[] {
  const ranked = holdings
    .map((holding) => ({ holding, credits: BigInt(holding.totalCredits) }))
    .sort((a, b) => {
      if (a.credits === b.credits) {
        return a.holding.claimantKey.localeCompare(b.holding.claimantKey);
      }
      return a.credits > b.credits ? -1 : 1;
    });
  const total = ranked.reduce((sum, entry) => sum + entry.credits, 0n);

  const toPercent = (amount: bigint): number => {
    if (total === 0n) return 0;
    // One decimal place, rounded half-up. The converted value is bounded to 0..1000.
    const tenths = Number((amount * 1_000n + total / 2n) / total);
    return tenths / 10;
  };

  const named = ranked.slice(0, MAX_NAMED_CREDIT_BARS).map((entry) => ({
    key: entry.holding.claimantKey,
    label: entry.holding.displayName ?? entry.holding.claimantLabel,
    totalCredits: entry.credits.toString(),
    sharePercent: toPercent(entry.credits),
    isOther: false,
  }));

  if (ranked.length <= MAX_NAMED_CREDIT_BARS) return named;

  const otherCredits = ranked
    .slice(MAX_NAMED_CREDIT_BARS)
    .reduce((sum, entry) => sum + entry.credits, 0n);
  return [
    ...named,
    {
      key: "other-contributors",
      label: `Other (${ranked.length - MAX_NAMED_CREDIT_BARS})`,
      totalCredits: otherCredits.toString(),
      sharePercent: toPercent(otherCredits),
      isOther: true,
    },
  ];
}

/** Format integer attribution credits without converting them to an unsafe JS number. */
export function formatCreditAmount(value: string | bigint): string {
  return BigInt(value).toLocaleString();
}
