// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-flight/flight-probe-credential`
 * Purpose: Resolve an operator-held flight-probe credential for one exact node/environment target.
 * Scope: Parse the injected secret JSON and perform exact-key lookup. No network or secret-store I/O.
 * Invariants:
 *   - EXACT_TARGET_ONLY: keys are `${env}/${nodeId}`; there is no default or fleet-wide fallback.
 *   - FAIL_CLOSED_CONFIG: missing, malformed, short, or non-string credentials resolve to null.
 *   - OPAQUE_SECRET: credential values are returned only to the HTTP prober and never logged.
 * Side-effects: none
 * Links: task.5218, task.5223, src/bootstrap/node-flight.factory.ts
 * @internal
 */

import { z } from "zod";
import type {
  FlightProbeCredential,
  FlightProbeCredentialResolver,
  FlightProbeTarget,
} from "@/ports";

const credentialMapSchema = z.record(z.string(), z.string().min(32));

function targetKey(
  target: Pick<FlightProbeTarget, "env" | "nodeId">
): string {
  return `${target.env}/${target.nodeId}`;
}

export class EnvFlightProbeCredentialResolver
  implements FlightProbeCredentialResolver
{
  private readonly credentials: Readonly<Record<string, string>> | null;

  constructor(serializedCredentials: string | undefined) {
    if (!serializedCredentials) {
      this.credentials = null;
      return;
    }
    try {
      const parsed = credentialMapSchema.safeParse(
        JSON.parse(serializedCredentials) as unknown
      );
      this.credentials = parsed.success ? parsed.data : null;
    } catch {
      this.credentials = null;
    }
  }

  resolve(
    target: Pick<FlightProbeTarget, "env" | "nodeId">
  ): FlightProbeCredential | null {
    const apiKey = this.credentials?.[targetKey(target)];
    return apiKey ? { apiKey } : null;
  }
}
