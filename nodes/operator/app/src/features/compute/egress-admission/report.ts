// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `report`
 * Purpose: Inert authenticated core. This is NOT an enabled HTTP route or trusted proxy parser.
 * Scope: Additive operator-only measured-admission core. No runtime activation.
 * Invariants: Existing receipt identity; no new pool, ledger or provider authority.
 * Side-effects: None at import; explicit callers own lifecycle.
 * Links: task.5385, compute-egress-measurement-writer
 * @internal
 */
import type { EgressReceiptPort } from "@/ports/egress-receipt.port";
import type { EgressReportIdentity } from "@/types/egress-admission";
import { type EgressReportKeyring, verifyReportCapability } from "./hmac";
import { isPublicEgressIpv4 } from "./policy";

export interface EgressReportInput {
  readonly identity: EgressReportIdentity;
  readonly token: string;
  /** Independently trusted ingress adapter output; NEVER request body policy. */
  readonly observedIpv4: string;
  readonly observerOrigin: string;
}

/** One process-local core. Bootstrap owns ONE instance and stop/drain; no HTTP route here.
 * Transport must independently bound headers/body/receive time before enabling this core.
 */
export class EgressReportCore {
  private receivers = 0;
  private stopped = false;
  private tokens = 64;
  private lastRefill: number;
  private readonly receiptsById = new Map<
    string,
    {
      fingerprint: string;
      ipv4: string;
      attemptedAt: number;
      lastSeen: number;
      accepted: boolean;
    }
  >();
  constructor(
    private readonly keyring: EgressReportKeyring,
    private readonly receipts: EgressReceiptPort,
    private readonly clock: () => number
  ) {
    this.lastRefill = clock();
  }
  get size(): number {
    return this.receiptsById.size;
  }
  get receiving(): number {
    return this.receivers;
  }
  stop(): void {
    this.stopped = true;
    this.receipts.stop();
  }
  /** Call BEFORE parsing; queue zero. Transport's 2s deadline must always release this permit. */
  tryReceive():
    | {
        release: () => void;
        report: (input: EgressReportInput) => Promise<void>;
      }
    | undefined {
    if (this.stopped || this.receivers >= 8) return undefined;
    this.receivers++;
    let released = false;
    let used = false;
    return {
      release: () => {
        if (!released) {
          released = true;
          this.receivers--;
        }
      },
      report: async (input) => {
        if (released || used || this.stopped)
          throw new Error("egress_receiver_closed");
        used = true;
        const now = this.clock();
        // No anonymous key/cardinality is retained. A backwards clock refills nothing.
        this.tokens = Math.min(
          64,
          this.tokens + (Math.max(0, now - this.lastRefill) * 64) / 1000
        );
        this.lastRefill = Math.max(now, this.lastRefill);
        if (this.tokens < 1) throw new Error("egress_crypto_overload");
        this.tokens--;
        if (!verifyReportCapability(input.identity, input.token, this.keyring))
          throw new Error("egress_unauthenticated");
        if (
          !isPublicEgressIpv4(input.observedIpv4) ||
          !input.observerOrigin.startsWith("https://") ||
          new URL(input.observerOrigin).origin !== input.observerOrigin
        )
          throw new Error("egress_invalid_observer");
        for (const [key, entry] of this.receiptsById) {
          if (now - entry.lastSeen >= 120_000) this.receiptsById.delete(key);
        }
        const fingerprint = JSON.stringify([
          input.identity.keyVersion,
          input.identity.nodeId,
          input.identity.lane,
          input.identity.compositeUid,
        ]);
        const old = this.receiptsById.get(input.identity.receiptId);
        if (old && old.fingerprint !== fingerprint)
          throw new Error("egress_receipt_identity_conflict");
        if (old && now - old.attemptedAt < 55_000) {
          old.lastSeen = now;
          if (old.ipv4 !== input.observedIpv4)
            throw new Error("egress_receipt_rate_limited");
          if (!old.accepted) throw new Error("egress_report_unavailable");
          return; // Coalescing NEVER refreshes an observation or its absolute expiry.
        }
        if (!old && this.receiptsById.size >= 64)
          throw new Error("egress_receipt_overload");
        const entry = {
          fingerprint,
          ipv4: input.observedIpv4,
          attemptedAt: now,
          lastSeen: now,
          accepted: false,
        };
        this.receiptsById.set(input.identity.receiptId, entry);
        await this.receipts.report(
          input.identity,
          input.observedIpv4,
          input.observerOrigin
        );
        entry.accepted = true;
      },
    };
  }
}
