// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/public/attribution/_lib/attribution-dto`
 * Purpose: DTO mappers for ledger domain types to contract wire format.
 * Scope: BigInt/Date → string conversion for JSON serialization. No business logic. Does not perform I/O or validation.
 * Invariants: ALL_MATH_BIGINT — all bigint values serialized as strings.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/store.ts, contracts/attribution.*.v1.contract
 * @internal
 */

import type {
  AttributionEpoch,
  AttributionPoolComponent,
  AttributionSelection,
  AttributionStatement,
  EpochUserProjection,
  IngestionReceipt,
} from "@cogni/attribution-ledger";

export function toEpochDto(e: AttributionEpoch) {
  return {
    id: e.id.toString(),
    status: e.status,
    periodStart: e.periodStart.toISOString(),
    periodEnd: e.periodEnd.toISOString(),
    weightConfig: e.weightConfig,
    poolTotalCredits: e.poolTotalCredits?.toString() ?? null,
    openedAt: e.openedAt.toISOString(),
    closedAt: e.closedAt?.toISOString() ?? null,
    createdAt: e.createdAt.toISOString(),
  };
}

export function toIngestionReceiptDto(e: IngestionReceipt) {
  return {
    receiptId: e.receiptId,
    source: e.source,
    eventType: e.eventType,
    platformUserId: e.platformUserId,
    platformLogin: e.platformLogin,
    artifactUrl: e.artifactUrl,
    metadata: e.metadata,
    eventTime: e.eventTime.toISOString(),
  };
}

export function toSelectionDto(c: AttributionSelection) {
  return {
    userId: c.userId,
    included: c.included,
    weightOverrideMilli: c.weightOverrideMilli?.toString() ?? null,
    note: c.note,
  };
}

export function toUserProjectionDto(a: EpochUserProjection) {
  return {
    id: a.id,
    userId: a.userId,
    projectedUnits: a.projectedUnits.toString(),
    receiptCount: a.receiptCount,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

export function toStatementDto(s: AttributionStatement) {
  return {
    id: s.id,
    epochId: s.epochId.toString(),
    finalAllocationSetHash: s.finalAllocationSetHash,
    poolTotalCredits: s.poolTotalCredits.toString(),
    statementLines: s.statementLines,
    supersedesStatementId: s.supersedesStatementId,
    createdAt: s.createdAt.toISOString(),
  };
}

export function toPoolComponentDto(c: AttributionPoolComponent) {
  return {
    id: c.id,
    componentId: c.componentId,
    amountCredits: c.amountCredits.toString(),
    computedAt: c.computedAt.toISOString(),
  };
}
