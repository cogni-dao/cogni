// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/session-admission`
 * Purpose: Bind operator knowledge errors, telemetry and existing budgets to the shared native session executor.
 * Scope: Thin injected-pool composition. Does not implement native ownership, admission, settlement, reconciliation or pool replacement.
 * Invariants: One helper module owns guards and native capacity; private domain errors and existing operator budgets remain stable.
 * Side-effects: IO (delegates native session operations), time (delegates deadlines)
 * Links: docs/spec/knowledge-data-plane.md, packages/knowledge-store/AGENTS.md
 * @public
 */

import { DoltNativeSessionExecutor } from "@cogni-dao/doltgres-admission";
import type { Sql } from "postgres";
import {
  KnowledgeBusyError,
  KnowledgeWriteOutcomeUnknownError,
} from "../../port/knowledge-store.port.js";
export interface DoltWriteConnection {
  unsafe(
    query: string
  ): Promise<readonly Record<string, unknown>[] & { readonly count?: number }>;
}
export interface DoltBranchWriterGuard {
  readonly baseDatabase: string;
  readonly protocol: "bridge" | "database";
  readonly keys: readonly string[];
  release(): Promise<void>;
}

/** Historical key retained for bridge compatibility, not an independent writer domain. */
export const KNOWLEDGE_BRANCH_LOCK_KEY = 5_001_002;

/** How long a queued operation waits for its turn before giving up. */
export const QUEUE_WAIT_MS = 90_000;
/**
 * How long to wait for a session-pinned connection once admitted.
 *
 * Covers the priming query AND the reserve: on an exhausted pool the prime is
 * what hangs, so bounding only the reserve bounds nothing.
 */
export const ACQUIRE_TIMEOUT_MS = 15_000;
/** How long to spin for the cross-replica advisory lock. */
export const LOCK_WAIT_MS = 90_000;
/** Gap between advisory-lock attempts. */
export const LOCK_RETRY_MS = 50;

export interface BranchSessionLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface BranchSessionOptions {
  readonly logger?: BranchSessionLogger;
  readonly queueWaitMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly lockWaitMs?: number;
  readonly lockRetryMs?: number;
  readonly writerProtocol?: "bridge" | "database";
  readonly queryTimeoutMs?: number;
  /**
   * Legacy configuration accepted for source compatibility. Automatic client
   * replacement is disabled: a closed client cannot prove native work ended.
   */
  readonly recreateClient?: () => Sql;
}

function messageForKnowledge(message: string): string {
  return message
    .replace(/\bDolt\b/g, "Knowledge")
    .replace(/\bdolt\b/g, "knowledge");
}

export class DoltBranchSessionRunner {
  private readonly executor: DoltNativeSessionExecutor<Sql>;
  constructor(sql: Sql, options: BranchSessionOptions = {}) {
    const logger = options.logger;
    const translateLog = (
      level: "info" | "warn" | "error",
      fields: Record<string, unknown>,
      message: string
    ) => {
      logger?.[level](
        {
          ...fields,
          event: "adapter.knowledge.branch_session",
          component: "doltgres-knowledge-store",
          operation:
            fields.operation === "dolt.write"
              ? "knowledge.write"
              : fields.operation,
        },
        messageForKnowledge(message)
      );
    };
    this.executor = new DoltNativeSessionExecutor(sql, {
      ...options,
      queueWaitMs: options.queueWaitMs ?? QUEUE_WAIT_MS,
      acquireTimeoutMs: options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
      lockWaitMs: options.lockWaitMs ?? LOCK_WAIT_MS,
      lockRetryMs: options.lockRetryMs ?? LOCK_RETRY_MS,
      errors: {
        busy: (message) => new KnowledgeBusyError(messageForKnowledge(message)),
        outcomeUnknown: (operationId, branch, commitHash) =>
          new KnowledgeWriteOutcomeUnknownError(
            operationId,
            branch,
            commitHash
          ),
        fault: (message) => new Error(messageForKnowledge(message)),
      },
      logger: {
        info: (fields, message) => translateLog("info", fields, message),
        warn: (fields, message) => translateLog("warn", fields, message),
        error: (fields, message) => translateLog("error", fields, message),
      },
    });
  }
  assertIndependentReadClient(reader: Sql): void {
    this.executor.assertIndependentReadClient(reader);
  }
  get client(): Sql {
    return this.executor.client;
  }
  async run<T>(
    operation: string,
    fn: (
      conn: DoltWriteConnection,
      guard: DoltBranchWriterGuard,
      owner: {
        registerReconciliation(reconcile: () => Promise<boolean>): void;
        committed(
          result: { value: T; commitHash: string },
          cleanup: () => Promise<void>
        ): void;
      }
    ) => Promise<T>,
    options: {
      readonly operationId?: string;
      /** CLI owners must settle native cleanup before closing their pool. */
      readonly awaitSettlement?: boolean;
    } = {}
  ): Promise<T> {
    return await this.executor.run(operation, fn, options);
  }
  async retire(connection: DoltWriteConnection, error: unknown): Promise<void> {
    await this.executor.retire(connection, error);
  }
}
