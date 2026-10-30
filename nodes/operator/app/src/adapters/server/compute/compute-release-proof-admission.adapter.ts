// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Proof-only max1 pool on the existing operator service role. Two fixed global slots.
 * No new tables or anonymous/keyed queues. The app feature is the sole admission owner.
 * Transport loss aborts native work; original reserve/query promises settle before reuse.
 */
import postgres, { type ReservedSql, type Sql } from "postgres";
import type {
  ComputeProofAdmissionLease,
  ComputeProofAdmissionPort,
} from "@/ports/compute-release-proof.port";
import type { ComputeReleaseProofInput } from "@/types/compute-release-proof";

export class PostgresComputeProofAdmission
  implements ComputeProofAdmissionPort
{
  private sql: Sql | undefined;
  private retiring = false;
  constructor(private readonly dsn: string) {}

  private client(): Sql {
    if (this.retiring) throw new Error("unavailable");
    this.sql ??= postgres(this.dsn, {
      max: 1,
      connect_timeout: 1,
      idle_timeout: 20,
      connection: {
        application_name: "compute-release-proof",
        statement_timeout: 100,
        lock_timeout: 100,
      },
    });
    return this.sql;
  }

  async acquire(
    input: ComputeReleaseProofInput,
    parent: AbortSignal
  ): Promise<ComputeProofAdmissionLease> {
    parent.throwIfAborted();
    const sql = this.client();
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    let closing: Promise<void> | undefined;
    let session: ReservedSql | undefined;
    let health = Promise.resolve();
    let stopped = false;
    let healthTimer: ReturnType<typeof setTimeout> | undefined;
    const retire = (): Promise<void> => {
      if (!closing) {
        this.retiring = true;
        // Assign before abort: the abort listener may re-enter this function.
        closing = Promise.resolve().then(() => sql.end({ timeout: 0 }));
        controller.abort();
      }
      return closing;
    };
    const abort = () => {
      void retire().catch(() => {
        /* cleanup awaits the same original close */
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    const original = async <T>(query: PromiseLike<T>): Promise<T> => {
      const value = await query;
      signal.throwIfAborted();
      return value;
    };
    const cleanup = async (): Promise<void> => {
      stopped = true;
      clearTimeout(healthTimer);
      try {
        await health;
        if (!closing && session) {
          try {
            await original(session`SELECT pg_advisory_unlock_all()`);
          } catch {
            await retire();
          }
        }
        if (closing) {
          // No replacement client exists until the real transport has closed.
          await closing;
          this.sql = undefined;
          this.retiring = false;
        }
      } finally {
        session?.release();
        signal.removeEventListener("abort", abort);
      }
    };
    const reserve = sql.reserve();
    // Observe immediately, including a rejection after the 100ms admission deadline.
    void reserve.catch(() => {});
    let reserveTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        reserveTimer = setTimeout(() => reject(new Error("unavailable")), 100);
      });
      try {
        session = await Promise.race([reserve, timeout]);
      } catch {
        await retire();
        try {
          const late = await reserve;
          late.release();
        } catch {
          /* original reserve settled */
        }
        throw new Error("unavailable");
      } finally {
        clearTimeout(reserveTimer);
      }
      signal.throwIfAborted();
      await original(session`SET statement_timeout = 100`);
      const slots = await original(
        session<
          { slot: number }[]
        >`SELECT slot FROM (SELECT CASE WHEN pg_try_advisory_lock(5390,0) THEN 0 WHEN pg_try_advisory_lock(5390,1) THEN 1 ELSE NULL END AS slot) s WHERE slot IS NOT NULL`
      );
      if (slots.length !== 1) throw new Error("unavailable");
      const rows = await original(
        session<
          {
            slug: string;
            repo_owner: string;
            repo_name: string;
            deploy_envs: string[];
          }[]
        >`SELECT slug,repo_owner,repo_name,deploy_envs FROM nodes WHERE id=${input.expected.nodeId}::uuid LIMIT 1`
      );
      const row = rows[0];
      if (
        !row ||
        `${row.repo_owner}/${row.repo_name}` !== input.expected.repository ||
        !row.deploy_envs.includes(input.expected.environment)
      )
        throw new Error("unavailable");
      const locks = await original(
        session<
          { locked: boolean }[]
        >`SELECT pg_try_advisory_lock(hashtextextended('compute-release-proof:' || ${input.expected.nodeId} || ':' || ${input.expected.environment},0)) AS locked`
      );
      if (locks[0]?.locked !== true) throw new Error("unavailable");
      const heldSession = session;
      const tick = () => {
        healthTimer = setTimeout(() => {
          if (stopped) return;
          health = (async () => {
            try {
              await original(heldSession`SELECT 1`);
              if (!stopped) tick();
            } catch {
              await retire();
            }
          })();
          // Keep the original promise observed until cleanup awaits it.
          void health.catch(() => {});
        }, 750);
      };
      tick();
      let released: Promise<void> | undefined;
      return {
        signal,
        release: () => {
          released ??= cleanup();
          return released;
        },
      };
    } catch {
      // Healthy contention/unknown registration releases locks and keeps the pool usable.
      // A failed query or timeout closes the transport if cleanup cannot verify unlock.
      await cleanup();
      throw new Error("unavailable");
    }
  }
}
