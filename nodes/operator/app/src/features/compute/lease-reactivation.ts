// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-reactivation`
 * Purpose: Derive the lease generation a RE-activated (node, environment) must be authored with
 *   (story.5039 PR-B). The actuator's idempotence key is spent forever once a lease under it
 *   closes terminally, so re-adding an env whose ledger already holds a receipt at the current
 *   generation MUST author a bumped `lease_generation` cell — else the next reconcile answers
 *   "already settled" and the workload never comes up.
 * Scope: One pure function over the catalog's current generation + the ledger's receipts. No
 *   I/O, no git, no provider.
 * Invariants:
 *   - GENERATION_IS_NOT_CALLER_INPUT still HOLDS (node-lease-generation.ts): the REST body never
 *     carries a generation. This function derives it from the LEDGER — durable receipt evidence,
 *     not caller choice — and the env verb passes the derived value into the catalog writer.
 *   - NOTHING_BUMPS_IMPLICITLY still HOLDS: the derived value becomes real only as a reviewed,
 *     merged catalog commit (the env verb's PR). The verb AUTHORS the commit FROM settled-receipt
 *     evidence; it bypasses neither the review nor the commit — no running system increments a
 *     generation on its own, and the catalog cell remains the only thing the Composition reads.
 *   - RECEIPT_EVIDENCE_ONLY: only `allocated`/`released` receipts count — states that bound a
 *     provider handle, whose key is therefore terminally spent (HANDLE_IS_WRITE_ONCE). A
 *     `preparing` receipt is mid-transaction and a `failed`-no-handle receipt is re-claimable
 *     under the SAME key (bug.5192), so neither forces a bump.
 * Side-effects: none
 * Links: src/features/compute/node-lease-generation.ts (the read twin),
 *   src/ports/akash-tx.port.ts (AkashTxAllocationRecord), story.5039, bug.5192
 * @public
 */

import type { AkashTxAllocationRecord } from "@/ports";

/**
 * The generation a fresh activation of this (node, environment) must state in the catalog.
 *
 * Any receipt in a handle-bound state (`allocated` | `released`) whose generation is >= the
 * catalog's current generation proves that generation's key is spent: the required generation
 * is max(such generations) + 1. Otherwise the catalog's own generation is already fresh and is
 * returned unchanged — an add with an empty ledger stays at generation 0, byte-identical to a
 * birth row.
 *
 * Receipts carry their generation as `identity.compositeGeneration` — the composite revision
 * durably bound to the receipt before the provider was contacted (IDENTITY_BEFORE_TRANSACTION).
 */
export function requiredLeaseGeneration(input: {
  readonly catalogGeneration: number;
  readonly receipts: readonly AkashTxAllocationRecord[];
}): number {
  const spent = input.receipts
    .filter(
      (receipt) =>
        (receipt.state === "allocated" || receipt.state === "released") &&
        receipt.identity.compositeGeneration >= input.catalogGeneration
    )
    .map((receipt) => receipt.identity.compositeGeneration);
  if (spent.length === 0) return input.catalogGeneration;
  return Math.max(...spent) + 1;
}
