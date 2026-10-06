// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/cogni-key`
 * Purpose: The ONE parser for the actuator idempotence key (`cogniKey`). The Crossplane
 *   composition authors keys as `xcw:<namespace>:<nodeId>:<leaseGeneration>`; bounded recovery
 *   (bug.5287) appends `:recover:<ordinal>`. Every consumer that needs the generation or the
 *   recovery ordinal parses THIS grammar — so it lives here once, not in a hand-rolled regex per
 *   call site.
 * Scope: pure string parsing. No I/O, no provider, no ledger.
 * Invariants:
 *   - GENERATION_IS_THE_GEN_COMPONENT: `generation` is the fourth `:`-segment of the BASE key and
 *     is NEVER the recovery ordinal. A greedy `.+:(\d+)$` regex reads `xcw:ns:node:0:recover:2`
 *     as generation 2 (the ordinal) instead of 0 — the misparse that pins a live lease's derived
 *     generation to its ordinal and double-pays (LIVE_KEEPS_ITS_GENERATION violation,
 *     lease-reactivation.ts). This module strips the recovery suffix BEFORE reading the generation.
 * Side-effects: none
 * Links: src/features/compute/lease-reactivation.ts, src/features/compute/akash-tx/akash-tx-actuator.ts
 * @public
 */

/**
 * The bounded-recovery suffix on a cogniKey. Exported so the `:recover:<n>` grammar has exactly
 * one definition shared by every splitter (the actuator's recovery-family grouping included).
 */
export const RECOVERY_SUFFIX_PATTERN = /:recover:(\d+)$/;

/** `xcw:<namespace>:<nodeId>:<generation>` — segments are colon-free by construction. */
const BASE_KEY_PATTERN = /^xcw:([^:]+):([^:]+):(0|[1-9]\d*)$/;

export interface CogniKey {
  /** Environment namespace, e.g. `cogni-production`. */
  readonly namespace: string;
  /** Node UUID. */
  readonly nodeId: string;
  /** Lease generation (the operator-controlled replacement counter). Always `>= 0`. */
  readonly generation: number;
  /** `0` for a base key; `n` for a bounded-recovery child `…:recover:n`. */
  readonly recoveryOrdinal: number;
  /** The generation base key with any `:recover:<n>` suffix removed. */
  readonly baseKey: string;
}

/**
 * Parse a cogniKey into its structured parts, or throw `Error("invalid cogniKey: …")` if it does
 * not match the grammar. `generation` is always taken from the base key's final segment, never the
 * recovery ordinal.
 */
export function parseCogniKey(cogniKey: string): CogniKey {
  const recovery = RECOVERY_SUFFIX_PATTERN.exec(cogniKey);
  const recoveryOrdinal = recovery ? Number(recovery[1]) : 0;
  const baseKey = recovery ? cogniKey.slice(0, recovery.index) : cogniKey;

  const base = BASE_KEY_PATTERN.exec(baseKey);
  if (!base) throw new Error(`invalid cogniKey: ${cogniKey}`);

  const generation = Number(base[3]);
  if (!Number.isSafeInteger(generation)) {
    throw new Error(`invalid cogniKey: ${cogniKey}`);
  }

  return {
    namespace: base[1] as string,
    nodeId: base[2] as string,
    generation,
    recoveryOrdinal,
    baseKey,
  };
}
