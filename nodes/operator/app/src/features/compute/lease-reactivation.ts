// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-reactivation`
 * Purpose: Derive the lease generation a RE-activated (node, environment) must be authored with
 *   (story.5039 PR-B). The actuator's idempotence key is spent forever once a lease under it
 *   settles terminally, so re-adding an env whose ledger already holds a terminal receipt at the
 *   current generation MUST author a bumped `lease_generation` cell — else the next reconcile
 *   answers with a refusal and the workload never comes up.
 * Scope: One pure function over the catalog's current generation + the ledger's receipts. No
 *   I/O, no git, no provider.
 * Invariants:
 *   - GENERATION_IS_NOT_CALLER_INPUT still HOLDS (node-lease-generation.ts): the REST body never
 *     carries a generation. This function derives it from the LEDGER — durable receipt evidence,
 *     not caller choice — and the env verb passes the derived value into the catalog writer.
 *   - NOTHING_BUMPS_IMPLICITLY still HOLDS: the derived value becomes real only as a reviewed,
 *     merged catalog commit (the env verb's PR). The verb AUTHORS the commit FROM receipt
 *     evidence; it bypasses neither the review nor the commit — no running system increments a
 *     generation on its own, and the catalog cell remains the only thing the Composition reads.
 *   - TERMINAL_SPENDS_THE_GENERATION (task.5132): every receipt in a TERMINAL state
 *     (`released` | `failed`) forces the next generation past it. `released` bound a handle, so
 *     its key is spent forever (HANDLE_IS_WRITE_ONCE). `failed` is terminal FROM THIS PATH too:
 *     the ledger's failed-no-handle re-claim (bug.5192) requires the SAME `compositeUid`, and an
 *     env-verb ADD recreates the XR with a NEW composite — so the recreated workload presenting
 *     the old generation's key hits the identity check, not the re-claim. Observed live
 *     2026-09-18T03:01:34Z: a terminally failed gen-0 receipt (ledgerState=failed, identity-bound
 *     to dead composite 02727e4b) while this derivation still answered 0 made the recreated XR
 *     present `xcw:cogni-candidate-a:4b06359a-…:0` and the actuator correctly refused it with
 *     `akash_tx_identity_conflict`.
 *   - LIVE_KEEPS_ITS_GENERATION: a non-terminal receipt never bumps. `preparing` is
 *     mid-transaction and proves nothing yet; `allocated` is a LIVE paid lease — it PINS the
 *     derived generation AT its own (so the catalog re-states the key that can replay/adopt the
 *     running resource) but bumping past it would abandon a billing lease and double-pay.
 * Side-effects: none
 * Links: src/features/compute/node-lease-generation.ts (the read twin),
 *   src/ports/akash-tx.port.ts (AkashTxAllocationRecord), story.5039, bug.5192, task.5132
 * @public
 */

import type { AkashTxAllocationRecord } from "@/ports";

/**
 * The generation a fresh activation of this (node, environment) must state in the catalog.
 *
 * `max` over: the catalog's own generation; `generation + 1` for every TERMINAL receipt
 * (`released` | `failed` — keys that can never be reused by a recreated composite,
 * TERMINAL_SPENDS_THE_GENERATION); and `generation` (no +1) for every LIVE `allocated` receipt
 * (LIVE_KEEPS_ITS_GENERATION). An add with an empty ledger stays at the catalog's generation —
 * 0 is byte-identical to a birth row.
 *
 * Receipts carry their generation as `identity.compositeGeneration` — the composite revision
 * durably bound to the receipt before the provider was contacted (IDENTITY_BEFORE_TRANSACTION).
 */
export function requiredLeaseGeneration(input: {
  readonly catalogGeneration: number;
  readonly receipts: readonly AkashTxAllocationRecord[];
}): number {
  let required = input.catalogGeneration;
  for (const receipt of input.receipts) {
    const generation = receipt.identity.compositeGeneration;
    if (receipt.state === "released" || receipt.state === "failed") {
      // Terminal: this generation's key is spent — the next activation needs the one after it.
      required = Math.max(required, generation + 1);
    } else if (receipt.state === "allocated") {
      // Live paid lease: the activation must re-state ITS generation, never leapfrog it.
      required = Math.max(required, generation);
    }
    // `preparing` is mid-transaction — not evidence in either direction.
  }
  return required;
}
