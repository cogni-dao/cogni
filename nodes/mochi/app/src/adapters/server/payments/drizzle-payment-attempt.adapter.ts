// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/payments/drizzle-payment-attempt`
 * Purpose: Drizzle-based payment attempt adapters split by trust boundary.
 * Scope: Implements payment attempt persistence and audit logging. Does not validate state transitions or perform business logic.
 * Invariants:
 * - UserDrizzlePaymentAttemptRepository wraps all queries in withTenantScope (RLS enforced)
 * - ServiceDrizzlePaymentAttemptRepository uses serviceDb directly (BYPASSRLS)
 * - Service mutators include billingAccountId in WHERE clause as defense-in-depth tenant anchor
 * - Partial unique index enforces no duplicate txHash per chain; dumb persistence only
 * Side-effects: IO (database operations)
 * Notes: State transition validation is feature layer responsibility via core/rules.isValidTransition(); repository just persists.
 * Links: Implements PaymentAttemptUserRepository + PaymentAttemptServiceRepository ports
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq, sql } from "drizzle-orm";

import type { Database } from "@/adapters/server/db/client";
import type {
  CreatePaymentAttemptParams,
  LogPaymentEventParams,
  PaymentAttempt,
  PaymentAttemptServiceRepository,
  PaymentAttemptStatus,
  PaymentAttemptUserRepository,
  PaymentErrorCode,
} from "@/ports";
import {
  PaymentAttemptNotFoundPortError,
  TxHashAlreadyBoundPortError,
} from "@/ports";
import { paymentAttempts, paymentEvents } from "@/shared/db";

type PaymentAttemptRow = typeof paymentAttempts.$inferSelect;
type TxHandle = Parameters<Parameters<Database["transaction"]>[0]>[0];

// --- Free functions (shared by both adapter classes) ---

function mapRow(row: PaymentAttemptRow): PaymentAttempt {
  return {
    id: row.id,
    billingAccountId: row.billingAccountId,
    fromAddress: row.fromAddress,
    chainId: row.chainId,
    txHash: row.txHash,
    token: row.token,
    toAddress: row.toAddress,
    amountRaw: row.amountRaw,
    amountUsdCents: row.amountUsdCents,
    status: row.status as PaymentAttemptStatus,
    errorCode: (row.errorCode as PaymentErrorCode) ?? null,
    expiresAt: row.expiresAt,
    submittedAt: row.submittedAt,
    lastVerifyAttemptAt: row.lastVerifyAttemptAt,
    verifyAttemptCount: row.verifyAttemptCount,
    createdAt: row.createdAt,
  };
}

async function logEventInTx(
  tx: TxHandle,
  params: LogPaymentEventParams
): Promise<void> {
  await tx.insert(paymentEvents).values({
    attemptId: params.attemptId,
    eventType: params.eventType,
    fromStatus: params.fromStatus,
    toStatus: params.toStatus,
    errorCode: params.errorCode ?? null,
    metadata: params.metadata ?? null,
  });
}

// --- UserDrizzlePaymentAttemptRepository (appDb, RLS enforced) ---

export class UserDrizzlePaymentAttemptRepository
  implements PaymentAttemptUserRepository
{
  private readonly actorId;

  constructor(
    private readonly db: Database,
    userId: UserId
  ) {
    this.actorId = userActor(userId);
  }

  async create(params: CreatePaymentAttemptParams): Promise<PaymentAttempt> {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const [row] = await tx
        .insert(paymentAttempts)
        .values({
          billingAccountId: params.billingAccountId,
          fromAddress: params.fromAddress,
          chainId: params.chainId,
          token: params.token,
          toAddress: params.toAddress,
          amountRaw: params.amountRaw,
          amountUsdCents: params.amountUsdCents,
          status: "CREATED_INTENT",
          expiresAt: params.expiresAt,
        })
        .returning();

      if (!row) {
        throw new Error("Failed to create payment attempt");
      }

      // Log creation event atomically
      await logEventInTx(tx, {
        attemptId: row.id,
        eventType: "INTENT_CREATED",
        fromStatus: null,
        toStatus: "CREATED_INTENT",
      });

      return mapRow(row);
    });
  }

  async findById(
    id: string,
    billingAccountId: string
  ): Promise<PaymentAttempt | null> {
    return withTenantScope(this.db, this.actorId, async (tx) => {
      const row = await tx.query.paymentAttempts.findFirst({
        where: and(
          eq(paymentAttempts.id, id),
          eq(paymentAttempts.billingAccountId, billingAccountId)
        ),
      });

      return row ? mapRow(row) : null;
    });
  }
}

// --- ServiceDrizzlePaymentAttemptRepository (serviceDb, BYPASSRLS) ---

export class ServiceDrizzlePaymentAttemptRepository
  implements PaymentAttemptServiceRepository
{
  constructor(private readonly db: Database) {}

  async findByTxHash(
    chainId: number,
    txHash: string
  ): Promise<PaymentAttempt | null> {
    const row = await this.db.query.paymentAttempts.findFirst({
      where: and(
        eq(paymentAttempts.chainId, chainId),
        eq(paymentAttempts.txHash, txHash)
      ),
    });

    return row ? mapRow(row) : null;
  }

  async updateStatus(
    id: string,
    billingAccountId: string,
    status: PaymentAttemptStatus,
    errorCode?: PaymentErrorCode
  ): Promise<PaymentAttempt> {
    return await this.db.transaction(async (tx) => {
      // Defense-in-depth: anchor to billingAccountId
      const existing = await tx.query.paymentAttempts.findFirst({
        where: and(
          eq(paymentAttempts.id, id),
          eq(paymentAttempts.billingAccountId, billingAccountId)
        ),
      });

      if (!existing) {
        throw new PaymentAttemptNotFoundPortError(id, billingAccountId);
      }

      const [updated] = await tx
        .update(paymentAttempts)
        .set({
          status,
          errorCode: errorCode ?? null,
        })
        .where(
          and(
            eq(paymentAttempts.id, id),
            eq(paymentAttempts.billingAccountId, billingAccountId)
          )
        )
        .returning();

      if (!updated) {
        throw new PaymentAttemptNotFoundPortError(id, billingAccountId);
      }

      // Log status transition
      await logEventInTx(tx, {
        attemptId: id,
        eventType: "STATUS_CHANGED",
        fromStatus: existing.status as PaymentAttemptStatus,
        toStatus: status,
        ...(errorCode ? { errorCode } : {}),
      });

      return mapRow(updated);
    });
  }

  async bindTxHash(
    id: string,
    billingAccountId: string,
    txHash: string,
    submittedAt: Date
  ): Promise<PaymentAttempt> {
    return await this.db.transaction(async (tx) => {
      // Defense-in-depth: anchor to billingAccountId
      const existing = await tx.query.paymentAttempts.findFirst({
        where: and(
          eq(paymentAttempts.id, id),
          eq(paymentAttempts.billingAccountId, billingAccountId)
        ),
      });

      if (!existing) {
        throw new PaymentAttemptNotFoundPortError(id, billingAccountId);
      }

      // Cross-user duplicate detection (intentionally unscoped)
      const duplicate = await tx.query.paymentAttempts.findFirst({
        where: and(
          eq(paymentAttempts.chainId, existing.chainId),
          eq(paymentAttempts.txHash, txHash)
        ),
      });

      if (duplicate && duplicate.id !== id) {
        throw new TxHashAlreadyBoundPortError(
          txHash,
          existing.chainId,
          duplicate.id
        );
      }

      const [updated] = await tx
        .update(paymentAttempts)
        .set({
          txHash,
          submittedAt,
          expiresAt: null,
          status: "PENDING_UNVERIFIED",
        })
        .where(
          and(
            eq(paymentAttempts.id, id),
            eq(paymentAttempts.billingAccountId, billingAccountId)
          )
        )
        .returning();

      if (!updated) {
        throw new PaymentAttemptNotFoundPortError(id, billingAccountId);
      }

      // Log submission event
      await logEventInTx(tx, {
        attemptId: id,
        eventType: "TX_SUBMITTED",
        fromStatus: existing.status as PaymentAttemptStatus,
        toStatus: "PENDING_UNVERIFIED",
        metadata: { txHash },
      });

      return mapRow(updated);
    });
  }

  async recordVerificationAttempt(
    id: string,
    billingAccountId: string,
    attemptedAt: Date
  ): Promise<PaymentAttempt> {
    return await this.db.transaction(async (tx) => {
      // Defense-in-depth: anchor to billingAccountId
      const existing = await tx.query.paymentAttempts.findFirst({
        where: and(
          eq(paymentAttempts.id, id),
          eq(paymentAttempts.billingAccountId, billingAccountId)
        ),
      });

      if (!existing) {
        throw new PaymentAttemptNotFoundPortError(id, billingAccountId);
      }

      const [updated] = await tx
        .update(paymentAttempts)
        .set({
          lastVerifyAttemptAt: attemptedAt,
          verifyAttemptCount: sql`${paymentAttempts.verifyAttemptCount} + 1`,
        })
        .where(
          and(
            eq(paymentAttempts.id, id),
            eq(paymentAttempts.billingAccountId, billingAccountId)
          )
        )
        .returning();

      if (!updated) {
        throw new PaymentAttemptNotFoundPortError(id, billingAccountId);
      }

      // Log verification attempt
      await logEventInTx(tx, {
        attemptId: id,
        eventType: "VERIFICATION_ATTEMPTED",
        fromStatus: existing.status as PaymentAttemptStatus,
        toStatus: existing.status as PaymentAttemptStatus,
      });

      return mapRow(updated);
    });
  }
}
