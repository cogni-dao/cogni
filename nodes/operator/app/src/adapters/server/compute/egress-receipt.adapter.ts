// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `egress-receipt.adapter`
 * Purpose: Existing-client receipt operations. SECURITY INVOKER functions own locks and write deadlines.
 * Scope: Additive operator-only measured-admission core. No runtime activation.
 * Invariants: Existing receipt identity; no new pool, ledger or provider authority.
 * Side-effects: Existing-client SQL only when explicitly invoked.
 * Links: task.5385, compute-egress-measurement-writer
 * @internal
 */
import type postgres from "postgres";
import type { EgressReceiptPort } from "@/ports/egress-receipt.port";
import type {
  EgressObservationSnapshot,
  EgressReceiptObservation,
  EgressReportIdentity,
} from "@/types/egress-admission";
import type { EgressQuerySlot } from "./egress-query-slot";

export class PostgresEgressReceiptAdapter implements EgressReceiptPort {
  // Bootstrap must create ONE instance per process and share it across report/projection users.
  constructor(
    private readonly sql: postgres.Sql,
    private readonly walletScope: string,
    private readonly slot: EgressQuerySlot
  ) {}
  stop(): void {
    this.slot.stop();
  }
  async pin(identity: EgressReportIdentity): Promise<string> {
    const rows = await this.slot.run(
      (deadline) => this.sql<{ version: string }[]>`
      select public.cogni_egress_pin(${this.walletScope}, ${identity.receiptId}::uuid,
        ${identity.nodeId}::uuid, ${identity.lane}, ${identity.compositeUid},
        ${identity.keyVersion}, ${deadline}::bigint) as version`
    );
    if (!rows[0]?.version) throw new Error("egress_pin_unavailable");
    return rows[0].version;
  }
  async report(
    identity: EgressReportIdentity,
    observedIpv4: string,
    observerOrigin: string
  ): Promise<void> {
    await this.slot.run(
      (deadline) => this.sql`
      select public.cogni_egress_report(${this.walletScope}, ${identity.receiptId}::uuid,
        ${identity.nodeId}::uuid, ${identity.lane}, ${identity.compositeUid},
        ${identity.keyVersion}, ${observedIpv4}, ${observerOrigin}, ${deadline}::bigint)`
    );
  }
  async snapshot(): Promise<EgressObservationSnapshot> {
    // LIMIT is a sentinel, never a replacement snapshot. One statement is one consistent view.
    const rows = await this.slot.run(
      () => this.sql<{ receiptId: string; observation: unknown }[]>`
      select a.id::text as "receiptId", item as observation
      from public.akash_tx_allocations a
      cross join lateral jsonb_array_elements(a.egress_observations) item
      where a.wallet_scope = ${this.walletScope} and a.state = 'allocated'
        and a.external_name is not null and a.egress_key_version is not null
      limit 4097`
    );
    if (rows.length > 4096) throw new Error("egress_observation_overflow");
    const observations: EgressReceiptObservation[] = rows.map((row) => {
      const item = row.observation as Record<string, unknown> | null;
      if (
        !item ||
        typeof item.ipv4 !== "string" ||
        typeof item.observedAt !== "number" ||
        typeof item.expiresAt !== "number" ||
        typeof item.observerOrigin !== "string"
      )
        throw new Error("egress_invalid_stored_observation");
      return {
        receiptId: row.receiptId,
        ipv4: item.ipv4,
        observedAt: item.observedAt,
        expiresAt: item.expiresAt,
        observerOrigin: item.observerOrigin,
      };
    });
    return { complete: true, observations };
  }
}
