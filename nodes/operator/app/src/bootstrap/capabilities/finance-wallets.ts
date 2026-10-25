// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/finance-wallets`
 * Purpose: Deduplicate Base USDC reader bindings before runtime IO.
 * Scope: Composition only; no addresses are added to the public finance row.
 * Invariants: A valid account counts once; absent/invalid roles remain separate unknown sources.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
export interface FinanceWalletBinding {
  name: string;
  label: string;
  address: string | undefined;
  beneficiary: string;
  payer: string;
}

export function uniqueWalletBindings(
  bindings: readonly FinanceWalletBinding[]
): FinanceWalletBinding[] {
  const result: FinanceWalletBinding[] = [];
  const accounts = new Map<string, FinanceWalletBinding>();
  for (const binding of bindings) {
    const address = binding.address;
    const key =
      address && /^0x[0-9a-fA-F]{40}$/.test(address)
        ? address.toLowerCase()
        : undefined;
    const existing = key ? accounts.get(key) : undefined;
    if (existing) {
      existing.beneficiary += ` · ${binding.label}: ${binding.beneficiary}`;
      if (existing.payer !== binding.payer)
        existing.payer += ` / ${binding.payer}`;
    } else {
      const copy = { ...binding };
      result.push(copy);
      if (key) accounts.set(key, copy);
    }
  }
  return result;
}
