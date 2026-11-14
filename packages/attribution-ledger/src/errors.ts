// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/attribution-ledger/errors`
 * Purpose: Domain error classes for ledger operations.
 * Scope: Error definitions and type guards. Does not perform I/O or contain business logic.
 * Invariants: All errors have a readonly `code` discriminant for type guards.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

export class EpochNotOpenError extends Error {
  public readonly code = "EPOCH_NOT_OPEN" as const;
  constructor(public readonly epochId: string) {
    super(`Epoch ${epochId} is not open`);
    this.name = "EpochNotOpenError";
  }
}

export class EpochAlreadyFinalizedError extends Error {
  public readonly code = "EPOCH_ALREADY_FINALIZED" as const;
  constructor(public readonly epochId: string) {
    super(`Epoch ${epochId} is already finalized`);
    this.name = "EpochAlreadyFinalizedError";
  }
}

export class EpochNotInReviewError extends Error {
  public readonly code = "EPOCH_NOT_IN_REVIEW" as const;
  constructor(
    public readonly epochId: string,
    public readonly actualStatus: string
  ) {
    super(`Epoch ${epochId} is not in review (status: ${actualStatus})`);
    this.name = "EpochNotInReviewError";
  }
}

export class PoolComponentMissingError extends Error {
  public readonly code = "POOL_COMPONENT_MISSING" as const;
  constructor(
    public readonly epochId: string,
    public readonly componentId: string
  ) {
    super(
      `Epoch ${epochId} is missing required pool component: ${componentId}`
    );
    this.name = "PoolComponentMissingError";
  }
}

export class EpochNotFoundError extends Error {
  public readonly code = "EPOCH_NOT_FOUND" as const;
  constructor(public readonly epochId: string) {
    super(`Epoch ${epochId} not found`);
    this.name = "EpochNotFoundError";
  }
}

export class AllocationNotFoundError extends Error {
  public readonly code = "ALLOCATION_NOT_FOUND" as const;
  constructor(
    public readonly epochId: string,
    public readonly userId: string
  ) {
    super(`Allocation not found for epoch ${epochId}, user ${userId}`);
    this.name = "AllocationNotFoundError";
  }
}

// Type guards

export function isEpochNotOpenError(
  error: unknown
): error is EpochNotOpenError {
  return error instanceof Error && error.name === "EpochNotOpenError";
}

export function isEpochAlreadyFinalizedError(
  error: unknown
): error is EpochAlreadyFinalizedError {
  return error instanceof Error && error.name === "EpochAlreadyFinalizedError";
}

export function isEpochNotInReviewError(
  error: unknown
): error is EpochNotInReviewError {
  return error instanceof Error && error.name === "EpochNotInReviewError";
}

export function isPoolComponentMissingError(
  error: unknown
): error is PoolComponentMissingError {
  return error instanceof Error && error.name === "PoolComponentMissingError";
}

export function isEpochNotFoundError(
  error: unknown
): error is EpochNotFoundError {
  return error instanceof Error && error.name === "EpochNotFoundError";
}

export function isAllocationNotFoundError(
  error: unknown
): error is AllocationNotFoundError {
  return error instanceof Error && error.name === "AllocationNotFoundError";
}
