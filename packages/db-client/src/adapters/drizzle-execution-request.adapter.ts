// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/scheduling/drizzle-execution-request`
 * Purpose: DrizzleExecutionRequestAdapter for execution request idempotency.
 * Scope: Implements ExecutionRequestPort with Drizzle ORM. Does not contain scheduling logic.
 * Invariants:
 *   - Per EXECUTION_IDEMPOTENCY_PERSISTED: Persists idempotency key → {ok, runId, traceId, errorCode}
 *   - Lifecycle: pending (ok=null) → finalized (ok=true/false)
 *   - Stores BOTH success and error outcomes - retries return cached outcome
 *   - idempotencyKey uniqueness enforced at DB level (primary key)
 *   - requestHash mismatch detection returns 'mismatch' status
 * Side-effects: IO (database operations)
 * Links: ports/scheduling/execution-request.port.ts, docs/spec/scheduler.md
 * @public
 */

import { isAiExecutionErrorCode } from "@cogni/ai-core";
import { executionRequests } from "@cogni/db-schema/scheduling";
import type {
  ExecutionOutcome,
  ExecutionRequest,
  ExecutionRequestPort,
  IdempotencyCheckResult,
} from "@cogni/scheduler-core";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import type { Database, LoggerLike } from "../client";

export class DrizzleExecutionRequestAdapter implements ExecutionRequestPort {
  private readonly logger: LoggerLike;

  constructor(
    private readonly db: Database,
    logger?: LoggerLike
  ) {
    this.logger = logger ?? {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    };
  }

  async checkIdempotency(
    idempotencyKey: string,
    requestHash: string
  ): Promise<IdempotencyCheckResult> {
    const existing = await this.db
      .select()
      .from(executionRequests)
      .where(eq(executionRequests.idempotencyKey, idempotencyKey))
      .limit(1);

    const record = existing[0];
    if (!record) {
      this.logger.debug(
        { idempotencyKey },
        "Idempotency key not found, new request"
      );
      return { status: "new" };
    }

    // Check if request hash matches
    if (record.requestHash !== requestHash) {
      this.logger.warn(
        {
          idempotencyKey,
          existingHash: record.requestHash,
          providedHash: requestHash,
        },
        "Idempotency key exists but request hash differs"
      );
      return {
        status: "mismatch",
        existingHash: record.requestHash,
        providedHash: requestHash,
      };
    }

    // Hash matches - check if pending (ok=null) or finalized (ok!=null)
    if (record.ok === null) {
      if (
        record.leaseExpiresAt !== null &&
        record.leaseExpiresAt.getTime() <= Date.now()
      ) {
        this.logger.info(
          { idempotencyKey, runId: record.runId },
          "Idempotency key hit, execution lease is stale"
        );
        return {
          status: "stale",
          request: this.toExecutionRequest(record),
        };
      }
      this.logger.info(
        { idempotencyKey, runId: record.runId },
        "Idempotency key hit, execution still pending"
      );
      return {
        status: "pending",
        request: this.toExecutionRequest(record),
      };
    }

    // Hash matches, finalized - return cached result with outcome
    this.logger.info(
      { idempotencyKey, runId: record.runId, ok: record.ok },
      "Idempotency key hit, returning cached result"
    );
    return {
      status: "cached",
      request: this.toExecutionRequest(record),
    };
  }

  async createPendingRequest(
    idempotencyKey: string,
    requestHash: string,
    runId: string,
    traceId: string | null,
    leaseExpiresAt?: string
  ): Promise<
    IdempotencyCheckResult | { status: "claimed"; request: ExecutionRequest }
  > {
    const now = new Date();
    if (leaseExpiresAt === undefined) {
      const [inserted] = await this.db
        .insert(executionRequests)
        .values({
          idempotencyKey,
          requestHash,
          runId,
          traceId,
          ok: null,
          errorCode: null,
        })
        .returning();
      if (!inserted) {
        throw new Error("Pending execution request insert returned no row");
      }
      return {
        status: "claimed",
        request: this.toExecutionRequest(inserted),
      };
    }

    const inserted = await this.db
      .insert(executionRequests)
      .values({
        idempotencyKey,
        requestHash,
        runId,
        traceId,
        ok: null,
        errorCode: null,
        updatedAt: now,
        leaseExpiresAt: new Date(leaseExpiresAt),
      })
      .onConflictDoNothing({ target: executionRequests.idempotencyKey })
      .returning();

    const insertedRecord = inserted[0];
    if (insertedRecord) {
      this.logger.info(
        { idempotencyKey, runId, traceId },
        "Created pending execution request"
      );
      return {
        status: "claimed",
        request: this.toExecutionRequest(insertedRecord),
      };
    }

    // A stale pending lease is re-claimable by exactly one contender. The
    // request hash guard prevents a different payload from taking the slot.
    const reclaimed = await this.db
      .update(executionRequests)
      .set({
        traceId,
        updatedAt: now,
        leaseExpiresAt: new Date(leaseExpiresAt),
      })
      .where(
        and(
          eq(executionRequests.idempotencyKey, idempotencyKey),
          eq(executionRequests.requestHash, requestHash),
          isNull(executionRequests.ok),
          or(
            isNull(executionRequests.leaseExpiresAt),
            lte(executionRequests.leaseExpiresAt, now)
          )
        )
      )
      .returning();

    const reclaimedRecord = reclaimed[0];
    if (reclaimedRecord) {
      this.logger.info(
        { idempotencyKey, runId },
        "Reclaimed stale execution request lease"
      );
      return {
        status: "claimed",
        request: this.toExecutionRequest(reclaimedRecord),
      };
    }

    // A concurrent claimant won or the existing request is already terminal.
    // Re-read after ON CONFLICT so the caller gets the canonical result.
    return this.checkIdempotency(idempotencyKey, requestHash);
  }

  async heartbeatRequest(
    idempotencyKey: string,
    leaseExpiresAt: string
  ): Promise<void> {
    await this.db
      .update(executionRequests)
      .set({ updatedAt: new Date(), leaseExpiresAt: new Date(leaseExpiresAt) })
      .where(
        and(
          eq(executionRequests.idempotencyKey, idempotencyKey),
          isNull(executionRequests.ok)
        )
      );
  }

  async finalizeRequest(
    idempotencyKey: string,
    outcome: ExecutionOutcome
  ): Promise<void> {
    await this.db
      .update(executionRequests)
      .set({
        ok: outcome.ok,
        errorCode: outcome.errorCode,
        updatedAt: new Date(),
        leaseExpiresAt: null,
      })
      .where(
        and(
          eq(executionRequests.idempotencyKey, idempotencyKey),
          isNull(executionRequests.ok)
        )
      );

    this.logger.info(
      { idempotencyKey, ok: outcome.ok, errorCode: outcome.errorCode },
      "Finalized execution request"
    );
  }

  /**
   * @deprecated Use createPendingRequest + finalizeRequest instead.
   */
  async storeRequest(
    idempotencyKey: string,
    requestHash: string,
    runId: string,
    traceId: string | null,
    outcome: ExecutionOutcome
  ): Promise<void> {
    await this.db.insert(executionRequests).values({
      idempotencyKey,
      requestHash,
      runId,
      traceId,
      ok: outcome.ok,
      errorCode: outcome.errorCode,
    });

    this.logger.info(
      { idempotencyKey, runId, ok: outcome.ok, errorCode: outcome.errorCode },
      "Stored execution request for idempotency (deprecated path)"
    );
  }

  private toExecutionRequest(
    row: typeof executionRequests.$inferSelect
  ): ExecutionRequest {
    // Validate errorCode is a known AiExecutionErrorCode (or null)
    const errorCode =
      row.errorCode && isAiExecutionErrorCode(row.errorCode)
        ? row.errorCode
        : null;

    return {
      idempotencyKey: row.idempotencyKey,
      requestHash: row.requestHash,
      runId: row.runId,
      traceId: row.traceId,
      ok: row.ok,
      errorCode,
    };
  }
}
