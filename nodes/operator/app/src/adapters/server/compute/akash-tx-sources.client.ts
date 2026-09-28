// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-tx-sources.client`
 * Purpose: The lease-log pump's client half of the actuator's `lease-log-sources` operation
 *   (bug.5240) — one bearer-authed POST returning every live lease's log coordinates plus a
 *   logs-scoped ephemeral JWT, schema-validated against the shared v1 wire contract.
 * Scope: HTTP IO only — returns the raw JSON body. Schema validation lives in the pump
 *   FEATURE (`AkashTxLeaseLogSourcesOutputSchema`): adapters may not import `@/contracts`
 *   (dependency-cruiser layer rule), and the feature owning the parse mirrors how
 *   akash-tx-http owns its wire schemas.
 * Invariants:
 *   - KEYLESS_CONSUMER: this client holds the actuator BEARER token only — never the Console
 *     API key, never a wallet capability. Custody stays with the actuator (story.5016).
 * Side-effects: IO (HTTP POST to the private ClusterIP actuator)
 * Links: features/compute/akash-tx/akash-tx-http.ts,
 *   features/compute/lease-log-pump/lease-log-pump.ts, bug.5240, task.5144
 * @internal
 */

export interface AkashTxSourcesClientConfig {
  /** Actuator base URL, e.g. `http://akash-tx-actuator:8080`. */
  readonly actuatorUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class AkashTxSourcesClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: AkashTxSourcesClientConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  /** Returns the raw JSON body; the pump feature validates it against the wire schema. */
  async fetch(input?: {
    environment?: string;
    limit?: number;
  }): Promise<unknown> {
    const response = await this.fetchImpl(
      `${this.config.actuatorUrl.replace(/\/+$/, "")}/v1/akash/lease-log-sources`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.token}`,
        },
        body: JSON.stringify({
          ...(input?.environment ? { environment: input.environment } : {}),
          ...(input?.limit ? { limit: input.limit } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `actuator lease-log-sources failed with HTTP ${response.status}: ` +
          detail.slice(0, 300)
      );
    }
    return await response.json();
  }
}
