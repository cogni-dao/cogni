// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/pool`
 * Purpose: Pool estimation framework — pure functions for computing pool component estimates from config.
 * Scope: Pure functions. Does not perform I/O or hold state. V0: returns only base_issuance from config.
 * Invariants:
 * - POOL_REPRODUCIBLE: Each pool component stores algorithm_version + inputs_json + amount_credits. Pure function.
 * - ALL_MATH_BIGINT: All credit values use BigInt.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

export interface PoolComponentEstimate {
  readonly componentId: string;
  readonly algorithmVersion: string;
  readonly inputsJson: Record<string, unknown>;
  readonly amountCredits: bigint;
  readonly evidenceRef?: string;
}

/** V0 pool component allowlist */
export const POOL_COMPONENT_ALLOWLIST = [
  "base_issuance",
  "kpi_bonus_v0",
  "top_up",
] as const;

export type PoolComponentId = (typeof POOL_COMPONENT_ALLOWLIST)[number];

/**
 * Validate that a component_id is in the V0 allowlist.
 * Throws on unknown component IDs.
 */
export function validatePoolComponentId(componentId: string): void {
  if (!(POOL_COMPONENT_ALLOWLIST as readonly string[]).includes(componentId)) {
    throw new Error(
      `Unknown pool component ID: "${componentId}". Allowed: ${POOL_COMPONENT_ALLOWLIST.join(", ")}`
    );
  }
}

/**
 * Estimate pool components for an epoch from config. Pure function.
 * V0: returns only base_issuance. Future: volume-based bonuses.
 */
export function estimatePoolComponentsV0(config: {
  baseIssuanceCredits: bigint;
}): PoolComponentEstimate[] {
  return [
    {
      componentId: "base_issuance",
      algorithmVersion: "config-constant-v0",
      inputsJson: {
        baseIssuanceCredits: config.baseIssuanceCredits.toString(),
      },
      amountCredits: config.baseIssuanceCredits,
    },
  ];
}
