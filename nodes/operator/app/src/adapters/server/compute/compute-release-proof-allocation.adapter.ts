// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * One bounded SELECT on a proof-only, read-only max1 connection using the existing app role.
 * Never shares/reserves/cancels/closes the wallet's pool. No global/session admission locks.
 * No positive after abort; reserve, query and transport originals settle before local reuse.
 */
import type { ReservedSql } from "postgres";
import { z } from "zod";
import type {
  ComputeProofAllocation,
  ComputeProofAllocationReadPort,
} from "@/ports";
import { proofPostgres } from "./compute-release-proof-postgres";

const rowSchema = z
  .object({
    node_id: z.string().uuid(),
    registered_slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    registered_repository: z
      .string()
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
    composite_uid: z.string().min(1).max(128),
    composite_generation: z.number().int().positive(),
    workload: z.string().min(1).max(128),
    environment: z.enum(["candidate-a", "preview", "production"]),
    state: z.literal("allocated"),
    external_name: z
      .string()
      .regex(/^[0-9]+$/)
      .max(128),
    provider_account: z.string().min(1).max(128),
  })
  .strict();

export class PostgresComputeProofAllocationReader
  implements ComputeProofAllocationReadPort
{
  private active = false;
  constructor(
    private readonly dsn: string,
    private readonly walletScope: string
  ) {
    if (!/^akash-console:akash1[0-9a-z]{38}$/.test(walletScope))
      throw new Error("unavailable");
  }
  async readOwnedAllocations(
    input: { nodeId: string; environment: string },
    parent: AbortSignal
  ): Promise<readonly ComputeProofAllocation[]> {
    z.object({
      nodeId: z.string().uuid(),
      environment: z.enum(["candidate-a", "preview", "production"]),
    })
      .strict()
      .parse(input);
    parent.throwIfAborted();
    // Transport busy refusal, not a second application/global admission owner or queue.
    if (this.active) throw new Error("unavailable");
    this.active = true;
    const reserveAbort = new AbortController();
    const signal = AbortSignal.any([
      parent,
      reserveAbort.signal,
      AbortSignal.timeout(1900),
    ]);
    const transport = proofPostgres(this.dsn, {
      application_name: "compute-release-proof-allocation",
      default_transaction_read_only: true,
      statement_timeout: 1500,
      lock_timeout: 1000,
    });
    const client = transport.sql;
    const close = () => transport.close();
    const abort = () => {
      void close().catch(() => {
        /* original close is awaited below; no capacity reuse on uncertainty */
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    let session: ReservedSql | undefined;
    let reserveTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const originalReserve = client.reserve();
      reserveTimer = setTimeout(() => reserveAbort.abort(), 100);
      // Do not race and discard the original reservation; abort destroys THIS transport.
      session = await originalReserve;
      clearTimeout(reserveTimer);
      signal.throwIfAborted();
      const originalQuery = session`SELECT a.node_id, n.slug AS registered_slug, n.repo_owner || '/' || n.repo_name AS registered_repository, a.composite_uid, a.composite_generation, a.workload, a.environment, a.state, a.external_name, a.provider_account FROM public.akash_tx_allocations a JOIN public.nodes n ON n.id=a.node_id AND a.environment=ANY(n.deploy_envs) WHERE a.wallet_scope=${this.walletScope} AND a.node_id=${input.nodeId}::uuid AND a.environment=${input.environment} AND a.state='allocated' AND a.external_name IS NOT NULL ORDER BY a.updated_at LIMIT 33`;
      const rows = await originalQuery;
      signal.throwIfAborted();
      if (rows.length >= 33) throw new Error("unavailable");
      const allocations = rows.map((value) => {
        const row = rowSchema.parse(value);
        return {
          identity: {
            nodeId: row.node_id,
            compositeUid: row.composite_uid,
            compositeGeneration: row.composite_generation,
          },
          registeredSlug: row.registered_slug,
          registeredRepository: row.registered_repository,
          workload: row.workload,
          environment: row.environment,
          state: row.state,
          externalName: row.external_name,
          providerAccount: row.provider_account,
        };
      });
      session.release();
      session = undefined;
      if (!(await close())) throw new Error("unavailable");
      signal.throwIfAborted();
      return allocations;
    } catch {
      throw new Error("unavailable");
    } finally {
      clearTimeout(reserveTimer);
      signal.removeEventListener("abort", abort);
      // Every earlier await observes its original. A rejected/unsettled teardown leaves
      // this reader fenced; it never destroys or reuses the wallet writer connection.
      const confirmed = await close();
      session?.release();
      if (confirmed) this.active = false;
    }
  }
}
