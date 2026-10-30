// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Sole app admission owner. Cap one, zero wait, before registry/native/provider/log IO. */
import type {
  ComputeProofAdmissionPort,
  ComputeReleaseProofPort,
} from "@/ports/compute-release-proof.port";
import { parseComputeProof } from "./request";
export class PublicComputeProof {
  private active = false;
  constructor(
    private readonly admission: ComputeProofAdmissionPort,
    private readonly client: ComputeReleaseProofPort
  ) {}
  async sample(body: string, parent: AbortSignal) {
    const input = parseComputeProof(body);
    if (this.active) return { status: 429, body: { code: "unavailable" } };
    this.active = true;
    const signal = AbortSignal.any([parent, AbortSignal.timeout(20_000)]);
    let lease:
      | Awaited<ReturnType<ComputeProofAdmissionPort["acquire"]>>
      | undefined;
    try {
      signal.throwIfAborted();
      lease = await this.admission.acquire(input, signal);
      const value = await this.client.sample(input, lease.signal);
      lease.signal.throwIfAborted();
      const held = lease;
      lease = undefined;
      await held.release();
      held.signal.throwIfAborted();
      signal.throwIfAborted();
      return { status: 200, body: value };
    } catch {
      return { status: 503, body: { code: "unavailable" } };
    } finally {
      try {
        await lease?.release();
      } finally {
        this.active = false;
      }
    }
  }
}
