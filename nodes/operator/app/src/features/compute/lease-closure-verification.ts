// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-closure-verification`
 * Purpose: Make the close PROVABLE (story.5039 PR-B, bug.5189: CLOSE→VERIFY→CLEAR). The env
 *   verb's `present:false` merely authors the git removal; the actual close rides the Argo
 *   prune → Crossplane REMOVE → actuator delete chain. This module answers the question that
 *   chain never answers on its own: did the money actually stop? Classification is a Console
 *   STATUS READ-BACK per receipt — cluster state is never spend truth (bug.5189's lesson: a
 *   deleted XR proves nothing about an escrow that is still draining).
 * Scope: Pure classification (`classifyReceiptClosure`, `orphanDiff`) + one thin service
 *   (`verifyLeaseClosures`) over an `AkashTxConsolePort`-like status reader. Decides nothing,
 *   settles nothing, deletes nothing — break-glass for a lease this surface flags is
 *   scripts/ops/recover-orphaned-akash-lease.sh.
 * Invariants:
 *   - READBACK_OR_UNKNOWN: `closed` is asserted ONLY from Console evidence (state `closed`) or
 *     from a receipt that provably never bound a handle. An unreachable Console, an unknown
 *     provider state, or an absent reader all classify `unknown`, never `closed`.
 *   - RELEASED_IS_A_CLAIM_NOT_A_PROOF: a `released` receipt whose Console status still bills
 *     (`active`/`pending`) classifies `open` — the ledger says closed, the provider says
 *     paying, and the provider is the spend truth. That mismatch is exactly what this module
 *     exists to flag.
 *   - ORPHAN_IS_A_SET_DIFFERENCE: an orphan is an `allocated` receipt whose (nodeId,
 *     environment) the catalog no longer declares. It is computed from the UNFILTERED
 *     wallet-scoped enumeration — a query shaped "leases of the declared envs" is structurally
 *     blind to it.
 * Side-effects: none in the pure half; the service performs Console reads via the injected
 *   status reader.
 * Links: src/ports/akash-tx.port.ts (AkashTxConsolePort.status, AkashTxAllocationRecord),
 *   scripts/ops/recover-orphaned-akash-lease.sh (break-glass), bug.5189, story.5039
 * @public
 */

import type { ProvisionState } from "@cogni/ai-tools";

import type { AkashTxAllocationRecord } from "@/ports";

/** Verdict of one receipt's Console read-back. */
export type LeaseClosure = "closed" | "open" | "unknown";

/** One verified receipt: the record plus its read-back verdict. */
export interface VerifiedLease {
  readonly receipt: AkashTxAllocationRecord;
  readonly closure: LeaseClosure;
}

/** A (node, environment) pair the catalog currently declares. */
export interface DeclaredPair {
  readonly nodeId: string;
  readonly environment: string;
}

/**
 * The `AkashTxConsolePort.status` seam, restated minimally so callers can inject the app's
 * read-only Console client (or nothing — an absent reader classifies handle-bearing receipts
 * `unknown`, never `closed`).
 */
export type LeaseStatusReader = (input: {
  leaseId: string;
}) => Promise<{ readonly state: ProvisionState }>;

/**
 * Pure: classify one receipt given its Console read-back (undefined = not read / unreadable).
 *
 * - No handle bound + settled `failed`: nothing was ever billing under this key (`fail()` is
 *   only ever written with that proof) → `closed`.
 * - No handle bound, not settled (`preparing`): mid-transaction, a paid lease MAY exist behind
 *   a lost response → `unknown`.
 * - Handle bound: the Console state decides — `closed` → closed; `active`/`pending` → open
 *   (even for a `released` receipt: RELEASED_IS_A_CLAIM_NOT_A_PROOF); anything else → unknown.
 */
export function classifyReceiptClosure(
  receipt: AkashTxAllocationRecord,
  consoleState: ProvisionState | undefined
): LeaseClosure {
  if (receipt.externalName === undefined) {
    return receipt.state === "failed" ? "closed" : "unknown";
  }
  if (consoleState === "closed") return "closed";
  if (consoleState === "active" || consoleState === "pending") return "open";
  return "unknown";
}

/**
 * Pure: the `allocated` receipts whose (nodeId, environment) is NOT in the catalog-declared
 * set — paid leases nothing in git points at any more (ORPHAN_IS_A_SET_DIFFERENCE). Only
 * `allocated` receipts qualify: a `released`/`failed` receipt is settled custody, not a live
 * undeclared spend (its closure honesty is `classifyReceiptClosure`'s axis, not this one's).
 */
export function orphanDiff(
  receipts: readonly AkashTxAllocationRecord[],
  declaredPairs: readonly DeclaredPair[]
): readonly AkashTxAllocationRecord[] {
  const declared = new Set(
    declaredPairs.map((pair) => `${pair.nodeId}|${pair.environment}`)
  );
  return receipts.filter(
    (receipt) =>
      receipt.state === "allocated" &&
      !declared.has(`${receipt.identity.nodeId}|${receipt.environment}`)
  );
}

/**
 * Thin service: read each handle-bearing receipt's Console status and classify it. A failed
 * read degrades that ONE receipt to `unknown` (READBACK_OR_UNKNOWN) — one dead provider read
 * must not blind the rest of the surface. With no reader injected, handle-bearing receipts
 * are all `unknown` and handle-less ones still classify purely.
 */
export async function verifyLeaseClosures(input: {
  readonly receipts: readonly AkashTxAllocationRecord[];
  readonly readStatus?: LeaseStatusReader | undefined;
}): Promise<readonly VerifiedLease[]> {
  return Promise.all(
    input.receipts.map(async (receipt) => {
      let consoleState: ProvisionState | undefined;
      if (receipt.externalName !== undefined && input.readStatus) {
        try {
          consoleState = (
            await input.readStatus({ leaseId: receipt.externalName })
          ).state;
        } catch {
          consoleState = undefined;
        }
      }
      return {
        receipt,
        closure: classifyReceiptClosure(receipt, consoleState),
      };
    })
  );
}
