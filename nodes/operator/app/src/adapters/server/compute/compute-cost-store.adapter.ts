// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Postgres implementation of the provider-neutral compute-cost ledger.
 *
 * The allocation receipt FK is the authority for node identity. Cost observations may add
 * facts, but they can never re-point a resource, change its native rate, reduce cumulative
 * transfer, or reopen a closed interval.
 */
import type { Database } from "@cogni/db-client";
import { eq, inArray, sql } from "drizzle-orm";

import {
  type ComputeCostAmount,
  ComputeCostInvariantError,
  type ComputeCostRate,
  type ComputeCostReport,
  type ComputeCostStorePort,
  type ComputeResourceCostEvidence,
  type ComputeResourceCostIdentity,
} from "@/ports";
import { akashTxAllocations, computeCostIntervals } from "@/shared/db/schema";

type CostRow = typeof computeCostIntervals.$inferSelect;

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const SIGNED_DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;
const POSITION_RE = /^(0|[1-9][0-9]*)$/;
const MAX_ID_LENGTH = 512;
const MAX_NATIVE_VALUE_LENGTH = 128;
const MAX_CHAIN_POSITION_LENGTH = 64;
const MAX_NATIVE_AMOUNTS = 32;

function hasAsciiControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ComputeCostInvariantError(message);
}

function assertText(value: string, field: string, maxLength: number): void {
  invariant(value.length > 0, `${field} is required`);
  invariant(value.length <= maxLength, `${field} is too long`);
  invariant(!/\s/u.test(value), `${field} has whitespace`);
  invariant(!hasAsciiControl(value), `${field} has control characters`);
}

function assertAmount(
  value: ComputeCostAmount,
  field: string,
  allowNegative = false
): void {
  assertText(value.denom, `${field} denom`, MAX_NATIVE_VALUE_LENGTH);
  invariant(
    value.amount.length <= MAX_NATIVE_VALUE_LENGTH,
    `${field} amount is too long`
  );
  invariant(
    (allowNegative ? SIGNED_DECIMAL_RE : DECIMAL_RE).test(value.amount),
    `${field} amount must be a ${allowNegative ? "signed" : "non-negative"} plain decimal`
  );
}

function assertAmounts(
  values: readonly ComputeCostAmount[],
  field: string,
  allowNegative = false
): void {
  invariant(
    values.length <= MAX_NATIVE_AMOUNTS,
    `${field} has too many denominations`
  );
  const denoms = new Set<string>();
  for (const value of values) {
    assertAmount(value, field, allowNegative);
    invariant(
      !denoms.has(value.denom),
      `${field} contains duplicate denominations`
    );
    denoms.add(value.denom);
  }
}

function assertPosition(value: string | undefined, field: string): void {
  if (value === undefined) return;
  invariant(value.length <= MAX_CHAIN_POSITION_LENGTH, `${field} is too long`);
  invariant(
    POSITION_RE.test(value),
    `${field} must be a non-negative integer string`
  );
}

function assertResource(resource: ComputeResourceCostIdentity): void {
  assertText(resource.computeProvider, "computeProvider", MAX_ID_LENGTH);
  assertText(
    resource.providerConsumerAccountId,
    "providerConsumerAccountId",
    MAX_ID_LENGTH
  );
  assertText(resource.resourceId, "resourceId", MAX_ID_LENGTH);
}

function assertEvidence(evidence: ComputeResourceCostEvidence): void {
  assertResource(evidence);
  assertText(
    evidence.providerSupplierAccountId,
    "providerSupplierAccountId",
    MAX_ID_LENGTH
  );
  assertAmount(evidence.rate, "rate");
  assertText(evidence.rate.unit, "rate unit", MAX_NATIVE_VALUE_LENGTH);
  invariant(
    evidence.observedAt instanceof Date &&
      Number.isFinite(evidence.observedAt.getTime()),
    "observedAt must be a valid Date"
  );
  assertPosition(evidence.providerOpenedAtPosition, "providerOpenedAtPosition");
  assertPosition(evidence.providerClosedAtPosition, "providerClosedAtPosition");
  assertPosition(
    evidence.escrow.providerSettledAtPosition,
    "providerSettledAtPosition"
  );
  if (evidence.providerOpenedAtPosition && evidence.providerClosedAtPosition) {
    invariant(
      BigInt(evidence.providerClosedAtPosition) >=
        BigInt(evidence.providerOpenedAtPosition),
      "providerClosedAtPosition cannot precede providerOpenedAtPosition"
    );
  }
  assertText(evidence.escrow.state, "escrow state", MAX_NATIVE_VALUE_LENGTH);
  assertAmounts(evidence.escrow.funds, "escrow funds", true);
  assertAmounts(evidence.escrow.transferred, "escrow transferred");
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  invariant(DECIMAL_RE.test(value), "amount must be a non-negative decimal");
  const [whole = "0", fraction = ""] = value.split(".");
  return { coefficient: BigInt(`${whole}${fraction}`), scale: fraction.length };
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const x = a.coefficient * 10n ** BigInt(scale - a.scale);
  const y = b.coefficient * 10n ** BigInt(scale - b.scale);
  return x < y ? -1 : x > y ? 1 : 0;
}

function addDecimal(left: string, right: string): string {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const sum =
    a.coefficient * 10n ** BigInt(scale - a.scale) +
    b.coefficient * 10n ** BigInt(scale - b.scale);
  if (scale === 0) return sum.toString();
  const padded = sum.toString().padStart(scale + 1, "0");
  const whole = padded.slice(0, -scale);
  const fraction = padded.slice(-scale).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

function amountsEqual(
  left: readonly ComputeCostAmount[],
  right: readonly ComputeCostAmount[]
): boolean {
  if (left.length !== right.length) return false;
  const byDenom = new Map(right.map((item) => [item.denom, item.amount]));
  return left.every((item) => byDenom.get(item.denom) === item.amount);
}

function assertTransferredMonotonic(
  before: readonly ComputeCostAmount[],
  after: readonly ComputeCostAmount[]
): void {
  const next = new Map(after.map((item) => [item.denom, item.amount]));
  for (const item of before) {
    const amount = next.get(item.denom);
    invariant(
      amount !== undefined,
      `cumulative transfer dropped denom '${item.denom}'`
    );
    invariant(
      compareDecimal(amount, item.amount) >= 0,
      `cumulative transfer regressed for '${item.denom}'`
    );
  }
}

function rowEvidence(row: CostRow): ComputeResourceCostEvidence | undefined {
  if (
    !row.providerConsumerAccountId ||
    !row.providerSupplierAccountId ||
    !row.rateAmount ||
    !row.rateDenom ||
    !row.rateUnit ||
    !row.escrowState ||
    !row.lastObservedAt
  )
    return undefined;
  return {
    computeProvider: row.computeProvider,
    resourceId: row.resourceId,
    providerConsumerAccountId: row.providerConsumerAccountId,
    providerSupplierAccountId: row.providerSupplierAccountId,
    rate: { amount: row.rateAmount, denom: row.rateDenom, unit: row.rateUnit },
    ...(row.providerOpenedAtPosition
      ? { providerOpenedAtPosition: row.providerOpenedAtPosition }
      : {}),
    ...(row.providerClosedAtPosition
      ? { providerClosedAtPosition: row.providerClosedAtPosition }
      : {}),
    escrow: {
      state: row.escrowState,
      ...(row.providerSettledAtPosition
        ? { providerSettledAtPosition: row.providerSettledAtPosition }
        : {}),
      funds: row.escrowFunds,
      transferred: row.cumulativeTransferred,
    },
    observedAt: row.lastObservedAt,
  };
}

function sameEvidence(
  left: ComputeResourceCostEvidence,
  right: ComputeResourceCostEvidence
): boolean {
  return (
    left.computeProvider === right.computeProvider &&
    left.resourceId === right.resourceId &&
    left.providerConsumerAccountId === right.providerConsumerAccountId &&
    left.providerSupplierAccountId === right.providerSupplierAccountId &&
    compareDecimal(left.rate.amount, right.rate.amount) === 0 &&
    left.rate.denom === right.rate.denom &&
    left.rate.unit === right.rate.unit &&
    left.providerOpenedAtPosition === right.providerOpenedAtPosition &&
    left.providerClosedAtPosition === right.providerClosedAtPosition &&
    left.escrow.state === right.escrow.state &&
    left.escrow.providerSettledAtPosition ===
      right.escrow.providerSettledAtPosition &&
    amountsEqual(left.escrow.funds, right.escrow.funds) &&
    amountsEqual(left.escrow.transferred, right.escrow.transferred) &&
    left.observedAt.getTime() === right.observedAt.getTime()
  );
}

function assertImmutableEvidence(
  existing: ComputeResourceCostEvidence,
  next: ComputeResourceCostEvidence
): void {
  invariant(
    existing.computeProvider === next.computeProvider,
    "computeProvider cannot change"
  );
  invariant(
    existing.resourceId === next.resourceId,
    "resourceId cannot change"
  );
  invariant(
    existing.providerConsumerAccountId === next.providerConsumerAccountId,
    "providerConsumerAccountId cannot change"
  );
  invariant(
    existing.providerSupplierAccountId === next.providerSupplierAccountId,
    "providerSupplierAccountId cannot change"
  );
  invariant(
    existing.rate.denom === next.rate.denom,
    "rate denom cannot change"
  );
  invariant(existing.rate.unit === next.rate.unit, "rate unit cannot change");
  invariant(
    compareDecimal(existing.rate.amount, next.rate.amount) === 0,
    "rate amount cannot change"
  );
  if (existing.providerOpenedAtPosition && next.providerOpenedAtPosition) {
    invariant(
      existing.providerOpenedAtPosition === next.providerOpenedAtPosition,
      "providerOpenedAtPosition cannot change"
    );
  }
  if (existing.providerClosedAtPosition && next.providerClosedAtPosition) {
    invariant(
      existing.providerClosedAtPosition === next.providerClosedAtPosition,
      "providerClosedAtPosition cannot change"
    );
  }
  const settledBefore = existing.escrow.providerSettledAtPosition;
  const settledAfter = next.escrow.providerSettledAtPosition;
  if (settledBefore && settledAfter) {
    invariant(
      BigInt(settledAfter) >= BigInt(settledBefore),
      "providerSettledAtPosition cannot regress"
    );
  }
}

function isUniqueViolation(error: unknown): boolean {
  const direct = (error as { code?: unknown })?.code;
  const nested = (error as { cause?: { code?: unknown } })?.cause?.code;
  return direct === "23505" || nested === "23505";
}

export class DrizzleComputeCostStore implements ComputeCostStorePort {
  constructor(private readonly getDb: () => Promise<Database>) {}

  async bind(input: {
    allocationReceiptId: string;
    resource: ComputeResourceCostIdentity;
  }): Promise<void> {
    assertResource(input.resource);
    const db = await this.getDb();
    try {
      await db.transaction(async (tx) => {
        const [receipt] = await tx
          .select({
            externalName: akashTxAllocations.externalName,
          })
          .from(akashTxAllocations)
          .where(eq(akashTxAllocations.id, input.allocationReceiptId))
          .for("update")
          .limit(1);
        invariant(
          receipt?.externalName === input.resource.resourceId,
          "cost resource does not match the durable allocation receipt"
        );
        const [existing] = await tx
          .select()
          .from(computeCostIntervals)
          .where(
            eq(
              computeCostIntervals.allocationReceiptId,
              input.allocationReceiptId
            )
          )
          .for("update")
          .limit(1);
        if (existing) {
          invariant(
            existing.computeProvider === input.resource.computeProvider &&
              existing.providerConsumerAccountId ===
                input.resource.providerConsumerAccountId &&
              existing.resourceId === input.resource.resourceId,
            "allocation receipt is already bound to another compute resource"
          );
          return;
        }
        await tx.insert(computeCostIntervals).values({
          allocationReceiptId: input.allocationReceiptId,
          state: "allocated",
          computeProvider: input.resource.computeProvider,
          providerConsumerAccountId: input.resource.providerConsumerAccountId,
          resourceId: input.resource.resourceId,
        });
      });
    } catch (error) {
      if (error instanceof ComputeCostInvariantError) throw error;
      if (isUniqueViolation(error)) {
        throw new ComputeCostInvariantError(
          "compute resource is already bound to another receipt"
        );
      }
      throw error;
    }
  }

  async observe(input: {
    allocationReceiptId: string;
    evidence: ComputeResourceCostEvidence;
  }): Promise<void> {
    assertEvidence(input.evidence);
    const db = await this.getDb();
    try {
      await db.transaction(async (tx) => {
        const [receipt] = await tx
          .select({ providerAccount: akashTxAllocations.providerAccount })
          .from(akashTxAllocations)
          .where(eq(akashTxAllocations.id, input.allocationReceiptId))
          .limit(1);
        invariant(receipt, "allocation receipt does not exist");
        if (receipt.providerAccount) {
          invariant(
            receipt.providerAccount ===
              input.evidence.providerSupplierAccountId,
            "cost supplier does not match the durable allocation receipt"
          );
        }
        const [row] = await tx
          .select()
          .from(computeCostIntervals)
          .where(
            eq(
              computeCostIntervals.allocationReceiptId,
              input.allocationReceiptId
            )
          )
          .for("update")
          .limit(1);
        invariant(row, "cost interval is not bound");
        invariant(
          row.computeProvider === input.evidence.computeProvider &&
            row.providerConsumerAccountId ===
              input.evidence.providerConsumerAccountId &&
            row.resourceId === input.evidence.resourceId,
          "evidence does not match the allocated compute resource"
        );
        const existing = rowEvidence(row);
        if (existing) {
          assertImmutableEvidence(existing, input.evidence);
          if (input.evidence.observedAt < existing.observedAt) return;
          if (
            input.evidence.observedAt.getTime() ===
            existing.observedAt.getTime()
          ) {
            invariant(
              sameEvidence(existing, input.evidence),
              "same observedAt carries different evidence"
            );
            return;
          }
          assertTransferredMonotonic(
            existing.escrow.transferred,
            input.evidence.escrow.transferred
          );
        }
        const opened =
          row.providerOpenedAtPosition ??
          input.evidence.providerOpenedAtPosition ??
          null;
        const closed =
          row.providerClosedAtPosition ??
          input.evidence.providerClosedAtPosition ??
          null;
        if (opened && closed) {
          invariant(
            BigInt(closed) >= BigInt(opened),
            "provider close cannot precede open"
          );
        }
        const observedSettled = input.evidence.escrow.providerSettledAtPosition;
        const settled = observedSettled
          ? row.providerSettledAtPosition &&
            BigInt(row.providerSettledAtPosition) > BigInt(observedSettled)
            ? row.providerSettledAtPosition
            : observedSettled
          : row.providerSettledAtPosition;
        const closedRecordedAt =
          row.closedRecordedAt ??
          (input.evidence.providerClosedAtPosition
            ? input.evidence.observedAt
            : null);
        await tx
          .update(computeCostIntervals)
          .set({
            state:
              row.state === "closed" || closedRecordedAt ? "closed" : "active",
            providerSupplierAccountId: input.evidence.providerSupplierAccountId,
            rateAmount: row.rateAmount ?? input.evidence.rate.amount,
            rateDenom: row.rateDenom ?? input.evidence.rate.denom,
            rateUnit: row.rateUnit ?? input.evidence.rate.unit,
            providerOpenedAtPosition: opened,
            providerClosedAtPosition: closed,
            escrowState: input.evidence.escrow.state,
            providerSettledAtPosition: settled,
            escrowFunds: input.evidence.escrow.funds,
            cumulativeTransferred: input.evidence.escrow.transferred,
            firstObservedAt: row.firstObservedAt ?? input.evidence.observedAt,
            lastObservedAt: input.evidence.observedAt,
            closedRecordedAt,
            updatedAt: sql`greatest(
              ${computeCostIntervals.updatedAt},
              now(),
              ${sql.param(input.evidence.observedAt, computeCostIntervals.updatedAt)}
            )`,
          })
          .where(
            eq(
              computeCostIntervals.allocationReceiptId,
              input.allocationReceiptId
            )
          );
      });
    } catch (error) {
      if (error instanceof ComputeCostInvariantError) throw error;
      if (isUniqueViolation(error)) {
        throw new ComputeCostInvariantError(
          "compute resource is already bound to another receipt for this consumer"
        );
      }
      throw error;
    }
  }

  async close(input: { allocationReceiptId: string }): Promise<void> {
    const db = await this.getDb();
    const result = await db
      .update(computeCostIntervals)
      .set({
        state: "closed",
        closedRecordedAt: sql`coalesce(${computeCostIntervals.closedRecordedAt}, now())`,
        updatedAt: sql`greatest(${computeCostIntervals.updatedAt}, now())`,
      })
      .where(
        eq(computeCostIntervals.allocationReceiptId, input.allocationReceiptId)
      )
      .returning({ id: computeCostIntervals.allocationReceiptId });
    invariant(result.length > 0, "cost interval is not bound");
  }

  private async buildReports(
    nodeIds?: readonly string[]
  ): Promise<readonly ComputeCostReport[]> {
    if (nodeIds?.length === 0) return [];
    const db = await this.getDb();
    const query = db
      .select({
        nodeId: akashTxAllocations.nodeId,
        state: computeCostIntervals.state,
        rateAmount: computeCostIntervals.rateAmount,
        rateDenom: computeCostIntervals.rateDenom,
        rateUnit: computeCostIntervals.rateUnit,
        transferred: computeCostIntervals.cumulativeTransferred,
      })
      .from(computeCostIntervals)
      .innerJoin(
        akashTxAllocations,
        eq(computeCostIntervals.allocationReceiptId, akashTxAllocations.id)
      );
    const rows = nodeIds
      ? await query.where(inArray(akashTxAllocations.nodeId, [...nodeIds]))
      : await query;
    const grouped = new Map<
      string,
      {
        allocatedIntervals: number;
        activeIntervals: number;
        closedIntervals: number;
        transferred: Map<string, string>;
        rates: Map<string, ComputeCostRate>;
      }
    >();
    for (const row of rows) {
      const report = grouped.get(row.nodeId) ?? {
        allocatedIntervals: 0,
        activeIntervals: 0,
        closedIntervals: 0,
        transferred: new Map<string, string>(),
        rates: new Map<string, ComputeCostRate>(),
      };
      if (row.state === "allocated") report.allocatedIntervals += 1;
      if (row.state === "active") report.activeIntervals += 1;
      if (row.state === "closed") report.closedIntervals += 1;
      for (const amount of row.transferred) {
        report.transferred.set(
          amount.denom,
          addDecimal(report.transferred.get(amount.denom) ?? "0", amount.amount)
        );
      }
      if (
        row.state === "active" &&
        row.rateAmount &&
        row.rateDenom &&
        row.rateUnit
      ) {
        const key = `${row.rateDenom}\u0000${row.rateUnit}`;
        const current = report.rates.get(key);
        report.rates.set(key, {
          denom: row.rateDenom,
          unit: row.rateUnit,
          amount: addDecimal(current?.amount ?? "0", row.rateAmount),
        });
      }
      grouped.set(row.nodeId, report);
    }
    return [...grouped.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([nodeId, report]) => ({
        nodeId,
        allocatedIntervals: report.allocatedIntervals,
        activeIntervals: report.activeIntervals,
        closedIntervals: report.closedIntervals,
        transferred: [...report.transferred.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([denom, amount]) => ({ denom, amount })),
        activeRates: [...report.rates.values()].sort((a, b) =>
          `${a.denom}\u0000${a.unit}`.localeCompare(`${b.denom}\u0000${b.unit}`)
        ),
      }));
  }

  async reportByNode(): Promise<readonly ComputeCostReport[]> {
    return this.buildReports();
  }

  async reportByNodeIds(
    nodeIds: readonly string[]
  ): Promise<readonly ComputeCostReport[]> {
    return this.buildReports([...new Set(nodeIds)]);
  }
}
