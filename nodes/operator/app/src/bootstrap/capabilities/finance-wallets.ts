// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/finance-wallets`
 * Purpose: Deduplicate Base USDC reader bindings before runtime IO.
 * Scope: Composition only; no addresses are added to the public finance row.
 * Invariants: One configured account reads once; its merged label names every role it serves.
 *   Absent or invalid addresses stay separate so each missing role is visible.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/task.5347
 * @internal
 */
import type { PayAction, Rail } from "@cogni/money-plane";

export interface FinanceWalletBinding {
  name: string;
  isTreasury?: boolean;
  label: string;
  address: string | undefined;
  payAction?: PayAction;
  note?: string;
  rail?: Rail;
}

export function uniqueWalletBindings(
  bindings: readonly FinanceWalletBinding[]
): FinanceWalletBinding[] {
  const result: FinanceWalletBinding[] = [];
  const accounts = new Map<string, FinanceWalletBinding>();
  for (const binding of bindings) {
    const key =
      binding.address && /^0x[0-9a-fA-F]{40}$/.test(binding.address)
        ? binding.address.toLowerCase()
        : undefined;
    const existing = key ? accounts.get(key) : undefined;
    if (existing) {
      if (binding.isTreasury) existing.isTreasury = true;
      existing.label += ` · ${binding.label}`;
      if (!existing.payAction && binding.payAction)
        existing.payAction = binding.payAction;
      if (!existing.note && binding.note) existing.note = binding.note;
      if (binding.payAction && binding.rail) existing.rail = binding.rail;
      continue;
    }
    const copy = { ...binding };
    result.push(copy);
    if (key) accounts.set(key, copy);
  }
  return result;
}
