// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/component/payments/drizzle-payment-attempt.adapter`
 * Purpose: Integration tests for UserDrizzlePaymentAttemptRepository + ServiceDrizzlePaymentAttemptRepository with real PostgreSQL database.
 * Scope: Tests adapter implementation against port contract with testcontainers. Does NOT test business logic.
 * Invariants: Adapter passes all port contract tests; ownership enforced via RLS; txHash uniqueness maintained; events logged.
 * Side-effects: IO (database operations via testcontainers)
 * Notes: Uses port harness for reusable contract tests; runs with testcontainers PostgreSQL via vitest.component.config.
 * Links: PaymentAttemptUserRepository + PaymentAttemptServiceRepository ports, payment-attempt.port.harness.ts
 * @public
 */

import { toUserId } from "@cogni/ids";
import { getSeedDb } from "@tests/_fixtures/db/seed-client";
import { describe } from "vitest";
import { getAppDb } from "@/adapters/server/db/client";
import {
  ServiceDrizzlePaymentAttemptRepository,
  UserDrizzlePaymentAttemptRepository,
} from "@/adapters/server/payments/drizzle-payment-attempt.adapter";
import type {
  PaymentAttemptServiceRepository,
  PaymentAttemptUserRepository,
} from "@/ports";
import type { TestHarness } from "../../ports/harness/factory";
import { registerPaymentAttemptRepositoryContract } from "../../ports/harness/payment-attempt.port.harness";

/**
 * Factory: UserDrizzlePaymentAttemptRepository (appDb, RLS enforced).
 * userId is known after seed — harness passes it in.
 */
async function makeUserRepo(
  userId: string,
  _harness: TestHarness
): Promise<PaymentAttemptUserRepository> {
  const db = getAppDb();
  return new UserDrizzlePaymentAttemptRepository(db, toUserId(userId));
}

/**
 * Factory: ServiceDrizzlePaymentAttemptRepository (serviceDb, BYPASSRLS).
 * Uses getSeedDb() which connects via the app_service role.
 */
async function makeServiceRepo(
  _harness: TestHarness
): Promise<PaymentAttemptServiceRepository> {
  const db = getSeedDb();
  return new ServiceDrizzlePaymentAttemptRepository(db);
}

describe("Drizzle Payment Attempt Adapters (RLS)", () => {
  registerPaymentAttemptRepositoryContract(makeUserRepo, makeServiceRepo);
});
