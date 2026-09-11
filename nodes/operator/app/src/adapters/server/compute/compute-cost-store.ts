// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/compute-cost-store`
 * Purpose: Persist paid compute intervals and produce an exact infrastructure node_id report.
 * Scope: Infrastructure resource-cost allocation only. No billing, fiat conversion, DAO/scope mapping,
 *   economic payer inference, provider calls, or controller composition.
 * Invariants: PREPARE_BEFORE_PROVIDER_IO, NODE_ID_IS_SOLE_GROUPING_KEY,
 *   ONE_INTERVAL_PER_RESOURCE, IMMUTABLE_EXTERNAL_IDENTITY_AND_RATE,
 *   MONOTONIC_PROVIDER_OBSERVATIONS, APP_ROLE_COMPATIBLE.
 * Side-effects: IO (Postgres through the injected Database).
 * Links: task.5071, src/ports/compute-cost-store.port.ts
 * @public
 */

import type { Database } from "@cogni/db-client";
import { and, eq } from "drizzle-orm";

import {
  type ComputeCostAmount,
  type ComputeCostInterval,
  ComputeCostInvariantError,
  type ComputeCostRate,
  type ComputeCostReport,
  type ComputeCostReportPort,
  type ComputeCostStorePort,
  type ComputeResourceCostContext,
  type ComputeResourceCostEvidence,
  type ComputeResourceCostIdentity,
} from "@/ports";
import { computeCostIntervals } from "@/shared/db/schema";

type CostRow = typeof computeCostIntervals.$inferSelect;

const DECIMAL_RE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new ComputeCostInvariantError(message);
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertAmount(value: ComputeCostAmount, context: string): void {
  invariant(value.denom.trim().length > 0, `${context} denom is required`);
  invariant(
    DECIMAL_RE.test(value.amount),
    `${context} amount must be a non-negative plain decimal`
  );
}

function assertDistinctAmounts(
  values: readonly ComputeCostAmount[],
  context: string
): void {
  const denoms = new Set<string>();
  for (const value of values) {
    assertAmount(value, context);
    invariant(
      !denoms.has(value.denom),
      `${context} contains duplicate denom '${value.denom}'`
    );
    denoms.add(value.denom);
  }
}

function decimalParts(value: string): { coefficient: bigint; scale: number } {
  invariant(DECIMAL_RE.test(value), "amount must be a non-negative decimal");
  const [whole = "0", fraction = ""] = value.split(".");
  return {
    coefficient: BigInt(`${whole}${fraction}`),
    scale: fraction.length,
  };
}

function compareDecimal(left: string, right: string): number {
  const a = decimalParts(left);
  const b = decimalParts(right);
  const scale = Math.max(a.scale, b.scale);
  const leftCoefficient = a.coefficient * 10n ** BigInt(scale - a.scale);
  const rightCoefficient = b.coefficient * 10n ** BigInt(scale - b.scale);
  return leftCoefficient < rightCoefficient
    ? -1
    : leftCoefficient > rightCoefficient
      ? 1
      : 0;
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
  previous: readonly ComputeCostAmount[],
  next: readonly ComputeCostAmount[]
): void {
  const nextByDenom = new Map(next.map((item) => [item.denom, item.amount]));
  for (const oldAmount of previous) {
    const nextAmount = nextByDenom.get(oldAmount.denom);
    invariant(
      nextAmount !== undefined,
      `cumulative transfer dropped denom '${oldAmount.denom}'`
    );
    invariant(
      compareDecimal(nextAmount, oldAmount.amount) >= 0,
      `cumulative transfer regressed for denom '${oldAmount.denom}'`
    );
  }
}

function assertContext(input: ComputeResourceCostContext): void {
  invariant(input.attemptKey.trim().length > 0, "attemptKey is required");
  invariant(input.nodeId.trim().length > 0, "nodeId is required");
  invariant(input.environment.trim().length > 0, "environment is required");
  invariant(input.workloadUid.trim().length > 0, "workloadUid is required");
  invariant(
    Number.isInteger(input.workloadGeneration) && input.workloadGeneration > 0,
    "workloadGeneration must be a positive integer"
  );
  invariant(
    /^[0-9a-f]{40}$/.test(input.sourceSha),
    "sourceSha must be 40 lowercase hex characters"
  );
  invariant(validDate(input.preparedAt), "preparedAt must be a valid Date");
}

function assertEvidence(evidence: ComputeResourceCostEvidence): void {
  assertResourceIdentity(evidence);
  invariant(
    evidence.computeProviderAccountId.trim().length > 0,
    "computeProviderAccountId is required"
  );
  invariant(
    evidence.computeSupplierAccountId.trim().length > 0,
    "computeSupplierAccountId is required"
  );
  assertAmount(evidence.rate, "rate");
  invariant(evidence.rate.unit.trim().length > 0, "rate unit is required");
  invariant(validDate(evidence.observedAt), "observedAt must be a valid Date");
  if (evidence.providerOpenedAtPosition) {
    invariant(
      /^(0|[1-9][0-9]*)$/.test(evidence.providerOpenedAtPosition),
      "providerOpenedAtPosition must be a non-negative integer string"
    );
  }
  if (evidence.providerClosedAtPosition) {
    invariant(
      /^(0|[1-9][0-9]*)$/.test(evidence.providerClosedAtPosition),
      "providerClosedAtPosition must be a non-negative integer string"
    );
    if (evidence.providerOpenedAtPosition) {
      invariant(
        BigInt(evidence.providerClosedAtPosition) >=
          BigInt(evidence.providerOpenedAtPosition),
        "providerClosedAtPosition cannot precede providerOpenedAtPosition"
      );
    }
  }
  if (evidence.escrow) {
    invariant(
      evidence.escrow.state.trim().length > 0,
      "escrow state is required"
    );
    if (evidence.escrow.providerSettledAtPosition) {
      invariant(
        /^(0|[1-9][0-9]*)$/.test(evidence.escrow.providerSettledAtPosition),
        "providerSettledAtPosition must be a non-negative integer string"
      );
    }
    assertDistinctAmounts(evidence.escrow.funds, "escrow funds");
    assertDistinctAmounts(evidence.escrow.transferred, "escrow transferred");
  }
}

function assertResourceIdentity(resource: ComputeResourceCostIdentity): void {
  invariant(
    resource.computeProvider.trim().length > 0,
    "computeProvider is required"
  );
  invariant(resource.resourceId.trim().length > 0, "resourceId is required");
}

function sameEvidence(
  left: ComputeResourceCostEvidence,
  right: ComputeResourceCostEvidence
): boolean {
  return (
    left.computeProvider === right.computeProvider &&
    left.resourceId === right.resourceId &&
    left.computeProviderAccountId === right.computeProviderAccountId &&
    left.computeSupplierAccountId === right.computeSupplierAccountId &&
    left.rate.amount === right.rate.amount &&
    left.rate.denom === right.rate.denom &&
    left.rate.unit === right.rate.unit &&
    left.providerOpenedAtPosition === right.providerOpenedAtPosition &&
    left.providerClosedAtPosition === right.providerClosedAtPosition &&
    left.escrow?.state === right.escrow?.state &&
    left.escrow?.providerSettledAtPosition ===
      right.escrow?.providerSettledAtPosition &&
    amountsEqual(left.escrow?.funds ?? [], right.escrow?.funds ?? []) &&
    amountsEqual(
      left.escrow?.transferred ?? [],
      right.escrow?.transferred ?? []
    ) &&
    left.observedAt.getTime() === right.observedAt.getTime()
  );
}

function rowEvidence(row: CostRow): ComputeResourceCostEvidence | undefined {
  if (
    !row.computeProvider ||
    !row.resourceId ||
    !row.computeProviderAccountId ||
    !row.computeSupplierAccountId ||
    !row.rateAmount ||
    !row.rateDenom ||
    !row.rateUnit ||
    !row.lastObservedAt
  ) {
    return undefined;
  }
  const escrow = row.escrowState
    ? {
        state: row.escrowState,
        ...(row.providerSettledAtPosition
          ? { providerSettledAtPosition: row.providerSettledAtPosition }
          : {}),
        funds: row.escrowFunds,
        transferred: row.cumulativeTransferred,
      }
    : undefined;
  return {
    computeProvider: row.computeProvider,
    resourceId: row.resourceId,
    computeProviderAccountId: row.computeProviderAccountId,
    computeSupplierAccountId: row.computeSupplierAccountId,
    rate: {
      amount: row.rateAmount,
      denom: row.rateDenom,
      unit: row.rateUnit,
    },
    ...(row.providerOpenedAtPosition
      ? { providerOpenedAtPosition: row.providerOpenedAtPosition }
      : {}),
    ...(row.providerClosedAtPosition
      ? { providerClosedAtPosition: row.providerClosedAtPosition }
      : {}),
    ...(escrow ? { escrow } : {}),
    observedAt: row.lastObservedAt,
  };
}

function rowInterval(row: CostRow): ComputeCostInterval {
  const evidence = rowEvidence(row);
  const resource =
    row.computeProvider && row.resourceId
      ? {
          computeProvider: row.computeProvider,
          resourceId: row.resourceId,
        }
      : undefined;
  return {
    attemptKey: row.attemptKey,
    nodeId: row.nodeId,
    environment: row.environment,
    workloadUid: row.workloadUid,
    workloadGeneration: row.workloadGeneration,
    sourceSha: row.sourceSha,
    resourceShape: row.resourceShape,
    preparedAt: row.preparedAt,
    state: row.state as ComputeCostInterval["state"],
    ...(resource ? { resource } : {}),
    ...(evidence ? { evidence } : {}),
    ...(row.closedRecordedAt ? { closedRecordedAt: row.closedRecordedAt } : {}),
  };
}

function assertSameContext(
  row: CostRow,
  input: ComputeResourceCostContext
): void {
  invariant(
    row.nodeId === input.nodeId,
    "attemptKey is already bound to another nodeId"
  );
  invariant(
    row.environment === input.environment,
    "attemptKey is already bound to another environment"
  );
  invariant(
    row.workloadUid === input.workloadUid,
    "attemptKey is already bound to another workloadUid"
  );
  invariant(
    row.workloadGeneration === input.workloadGeneration,
    "attemptKey is already bound to another workloadGeneration"
  );
  invariant(
    row.sourceSha === input.sourceSha,
    "attemptKey is already bound to another sourceSha"
  );
  invariant(
    canonicalJson(row.resourceShape) === canonicalJson(input.resourceShape),
    "attemptKey is already bound to another resourceShape"
  );
  invariant(
    row.preparedAt.getTime() === input.preparedAt.getTime(),
    "attemptKey is already bound to another preparedAt"
  );
}

function assertSameResourceIdentity(
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
    existing.computeProviderAccountId === next.computeProviderAccountId,
    "computeProviderAccountId cannot change"
  );
  invariant(
    existing.computeSupplierAccountId === next.computeSupplierAccountId,
    "computeSupplierAccountId cannot change"
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
  const existingSettled = existing.escrow?.providerSettledAtPosition;
  const nextSettled = next.escrow?.providerSettledAtPosition;
  if (existingSettled && nextSettled) {
    invariant(
      BigInt(nextSettled) >= BigInt(existingSettled),
      "providerSettledAtPosition cannot regress"
    );
  }
}

function uniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

export class DrizzleComputeCostStore
  implements ComputeCostStorePort, ComputeCostReportPort
{
  constructor(private readonly db: Database) {}

  async prepare(
    input: ComputeResourceCostContext
  ): Promise<ComputeCostInterval> {
    assertContext(input);
    return this.db.transaction(async (tx) => {
      await tx.insert(computeCostIntervals).values(input).onConflictDoNothing({
        target: computeCostIntervals.attemptKey,
      });
      const [row] = await tx
        .select()
        .from(computeCostIntervals)
        .where(eq(computeCostIntervals.attemptKey, input.attemptKey))
        .limit(1)
        .for("update");
      invariant(row, "prepared cost interval was not persisted");
      assertSameContext(row, input);
      return rowInterval(row);
    });
  }

  async bind(input: {
    attemptKey: string;
    resource: ComputeResourceCostIdentity;
  }): Promise<ComputeCostInterval> {
    assertResourceIdentity(input.resource);
    try {
      return await this.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(computeCostIntervals)
          .where(eq(computeCostIntervals.attemptKey, input.attemptKey))
          .limit(1)
          .for("update");
        invariant(row, `cost interval '${input.attemptKey}' is not prepared`);
        if (row.computeProvider || row.resourceId) {
          invariant(
            row.computeProvider === input.resource.computeProvider &&
              row.resourceId === input.resource.resourceId,
            "attemptKey is already bound to another provider resource"
          );
          return rowInterval(row);
        }
        invariant(
          row.state === "prepared",
          "only a prepared interval can be bound"
        );
        const [resourceOwner] = await tx
          .select({ attemptKey: computeCostIntervals.attemptKey })
          .from(computeCostIntervals)
          .where(
            and(
              eq(
                computeCostIntervals.computeProvider,
                input.resource.computeProvider
              ),
              eq(computeCostIntervals.resourceId, input.resource.resourceId)
            )
          )
          .limit(1)
          .for("update");
        invariant(
          !resourceOwner || resourceOwner.attemptKey === input.attemptKey,
          "provider resource is already allocated to another attempt"
        );
        const [updated] = await tx
          .update(computeCostIntervals)
          .set({
            state: "allocated",
            computeProvider: input.resource.computeProvider,
            resourceId: input.resource.resourceId,
          })
          .where(eq(computeCostIntervals.attemptKey, input.attemptKey))
          .returning();
        invariant(updated, "provider resource identity was not persisted");
        return rowInterval(updated);
      });
    } catch (error) {
      if (error instanceof ComputeCostInvariantError) throw error;
      if (uniqueViolation(error)) {
        throw new ComputeCostInvariantError(
          "provider resource is already allocated to another attempt"
        );
      }
      throw error;
    }
  }

  async observe(input: {
    attemptKey: string;
    evidence: ComputeResourceCostEvidence;
  }): Promise<ComputeCostInterval> {
    return this.recordEvidence(input);
  }

  async close(input: {
    attemptKey: string;
    closedRecordedAt: Date;
  }): Promise<ComputeCostInterval> {
    invariant(
      validDate(input.closedRecordedAt),
      "closedRecordedAt must be a valid Date"
    );
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(computeCostIntervals)
        .where(eq(computeCostIntervals.attemptKey, input.attemptKey))
        .limit(1)
        .for("update");
      invariant(row, `cost interval '${input.attemptKey}' does not exist`);
      invariant(
        row.computeProvider && row.resourceId,
        "cannot close before a provider resource is allocated"
      );
      if (row.closedRecordedAt) {
        invariant(
          input.closedRecordedAt.getTime() >= row.closedRecordedAt.getTime(),
          "closedRecordedAt cannot regress"
        );
        return rowInterval(row);
      }
      if (row.lastObservedAt) {
        invariant(
          input.closedRecordedAt.getTime() >= row.lastObservedAt.getTime(),
          "closedRecordedAt cannot precede the last provider observation"
        );
      }
      const [updated] = await tx
        .update(computeCostIntervals)
        .set({
          state: "closed",
          closedRecordedAt: input.closedRecordedAt,
          updatedAt: input.closedRecordedAt,
        })
        .where(eq(computeCostIntervals.attemptKey, input.attemptKey))
        .returning();
      invariant(updated, "cost interval close was not persisted");
      return rowInterval(updated);
    });
  }

  async findByResource(input: {
    computeProvider: string;
    resourceId: string;
  }): Promise<ComputeCostInterval | null> {
    const [row] = await this.db
      .select()
      .from(computeCostIntervals)
      .where(
        and(
          eq(computeCostIntervals.computeProvider, input.computeProvider),
          eq(computeCostIntervals.resourceId, input.resourceId)
        )
      )
      .limit(1);
    return row ? rowInterval(row) : null;
  }

  async reportByNode(): Promise<readonly ComputeCostReport[]> {
    const rows = await this.db.select().from(computeCostIntervals);
    const grouped = new Map<
      string,
      {
        preparedIntervals: number;
        allocatedIntervals: number;
        activeIntervals: number;
        closedIntervals: number;
        transferred: Map<string, string>;
        activeRates: Map<string, ComputeCostRate>;
      }
    >();
    for (const row of rows) {
      const report = grouped.get(row.nodeId) ?? {
        preparedIntervals: 0,
        allocatedIntervals: 0,
        activeIntervals: 0,
        closedIntervals: 0,
        transferred: new Map<string, string>(),
        activeRates: new Map<string, ComputeCostRate>(),
      };
      if (row.state === "prepared") report.preparedIntervals += 1;
      if (row.state === "allocated") report.allocatedIntervals += 1;
      if (row.state === "active") report.activeIntervals += 1;
      if (row.state === "closed") report.closedIntervals += 1;
      for (const amount of row.cumulativeTransferred) {
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
        const current = report.activeRates.get(key);
        report.activeRates.set(key, {
          denom: row.rateDenom,
          unit: row.rateUnit,
          amount: addDecimal(current?.amount ?? "0", row.rateAmount),
        });
      }
      grouped.set(row.nodeId, report);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([nodeId, report]) => ({
        nodeId,
        preparedIntervals: report.preparedIntervals,
        allocatedIntervals: report.allocatedIntervals,
        activeIntervals: report.activeIntervals,
        closedIntervals: report.closedIntervals,
        transferred: [...report.transferred.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([denom, amount]) => ({ denom, amount })),
        activeRates: [...report.activeRates.values()].sort((left, right) =>
          `${left.denom}\u0000${left.unit}`.localeCompare(
            `${right.denom}\u0000${right.unit}`
          )
        ),
      }));
  }

  private async recordEvidence(input: {
    attemptKey: string;
    evidence: ComputeResourceCostEvidence;
  }): Promise<ComputeCostInterval> {
    assertEvidence(input.evidence);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(computeCostIntervals)
        .where(eq(computeCostIntervals.attemptKey, input.attemptKey))
        .limit(1)
        .for("update");
      invariant(row, `cost interval '${input.attemptKey}' does not exist`);
      invariant(
        row.computeProvider === input.evidence.computeProvider &&
          row.resourceId === input.evidence.resourceId,
        "evidence does not match the allocated provider resource"
      );
      const existingEvidence = rowEvidence(row);
      if (existingEvidence) {
        assertSameResourceIdentity(existingEvidence, input.evidence);
        const previousTransferred = existingEvidence.escrow?.transferred ?? [];
        const nextTransferred =
          input.evidence.escrow?.transferred ?? previousTransferred;
        if (
          input.evidence.observedAt.getTime() <
          existingEvidence.observedAt.getTime()
        ) {
          return rowInterval(row);
        }
        if (
          input.evidence.observedAt.getTime() ===
          existingEvidence.observedAt.getTime()
        ) {
          invariant(
            sameEvidence(existingEvidence, input.evidence),
            "same observedAt carries different provider evidence"
          );
          return rowInterval(row);
        }
        assertTransferredMonotonic(previousTransferred, nextTransferred);
      }

      const nextOpenedPosition =
        row.providerOpenedAtPosition ??
        input.evidence.providerOpenedAtPosition ??
        null;
      const nextClosedPosition =
        row.providerClosedAtPosition ??
        input.evidence.providerClosedAtPosition ??
        null;
      if (nextOpenedPosition && nextClosedPosition) {
        invariant(
          BigInt(nextClosedPosition) >= BigInt(nextOpenedPosition),
          "providerClosedAtPosition cannot precede providerOpenedAtPosition"
        );
      }
      const observedSettledPosition =
        input.evidence.escrow?.providerSettledAtPosition;
      const nextSettledPosition = observedSettledPosition
        ? row.providerSettledAtPosition &&
          BigInt(row.providerSettledAtPosition) >
            BigInt(observedSettledPosition)
          ? row.providerSettledAtPosition
          : observedSettledPosition
        : row.providerSettledAtPosition;
      const nextClosedRecordedAt =
        row.closedRecordedAt ??
        (input.evidence.providerClosedAtPosition
          ? input.evidence.observedAt
          : null);
      const [updated] = await tx
        .update(computeCostIntervals)
        .set({
          state: nextClosedRecordedAt ? "closed" : "active",
          computeProvider: input.evidence.computeProvider,
          resourceId: input.evidence.resourceId,
          computeProviderAccountId: input.evidence.computeProviderAccountId,
          computeSupplierAccountId: input.evidence.computeSupplierAccountId,
          rateAmount: row.rateAmount ?? input.evidence.rate.amount,
          rateDenom: input.evidence.rate.denom,
          rateUnit: input.evidence.rate.unit,
          providerOpenedAtPosition: nextOpenedPosition,
          providerClosedAtPosition: nextClosedPosition,
          escrowState: input.evidence.escrow?.state ?? row.escrowState,
          providerSettledAtPosition: nextSettledPosition,
          escrowFunds: input.evidence.escrow?.funds ?? row.escrowFunds,
          cumulativeTransferred:
            input.evidence.escrow?.transferred ?? row.cumulativeTransferred,
          firstObservedAt: row.firstObservedAt ?? input.evidence.observedAt,
          lastObservedAt: input.evidence.observedAt,
          closedRecordedAt: nextClosedRecordedAt,
          updatedAt: new Date(
            Math.max(
              row.updatedAt.getTime(),
              input.evidence.observedAt.getTime()
            )
          ),
        })
        .where(eq(computeCostIntervals.attemptKey, input.attemptKey))
        .returning();
      invariant(updated, "cost interval evidence was not persisted");
      return rowInterval(updated);
    });
  }
}
