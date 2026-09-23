// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/observability/loki-push.adapter`
 * Purpose: Minimal Grafana Cloud Loki push client for the lease-log pump (bug.5240) — one
 *   POST of `{streams:[{stream, values}]}` per call, basic-auth with the DEDICATED
 *   logs:write-only lease credential (`LOKI_LEASE_PUSH_*`, infra/secrets-catalog.yaml).
 * Scope: HTTP IO only. Labels, timestamps and batching are the pump's; this class never
 *   invents either.
 * Invariants:
 *   - SCOPED_CREDS_ONLY: constructed with the write-only lease push token, never a fleet
 *     read/admin Grafana credential (the same rule the bug.5127 catalog entry states).
 *   - PUSH_IS_ATOMIC_TO_THE_CALLER: non-2xx or network failure throws; the caller decides
 *     what a failed batch means (the pump re-ships — CURSORS_COMMIT_AFTER_PUSH).
 * Side-effects: IO (HTTPS POST to the Loki push endpoint)
 * Links: @ports/lease-log.port, features/compute/lease-log-pump/lease-log-pump.ts,
 *   infra/secrets-catalog.yaml (LOKI_LEASE_PUSH_*), bug.5240, task.5144
 * @internal
 */

import type { LeaseLogPushPort, LeaseLogStream } from "@/ports";

export interface HttpLokiPusherConfig {
  /** Full push endpoint, e.g. `https://logs-prod-xyz.grafana.net/loki/api/v1/push`. */
  readonly url: string;
  readonly username: string;
  readonly password: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HttpLokiPusher implements LeaseLogPushPort {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: HttpLokiPusherConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async push(streams: readonly LeaseLogStream[]): Promise<void> {
    if (streams.length === 0) return;
    const body = JSON.stringify({
      streams: streams.map((s) => ({ stream: s.labels, values: s.values })),
    });
    const auth = Buffer.from(
      `${this.config.username}:${this.config.password}`
    ).toString("base64");
    const response = await this.fetchImpl(this.config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${auth}`,
      },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!response.ok) {
      // Loki error bodies are small and label-only; safe and load-bearing for diagnosis.
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Loki push failed with HTTP ${response.status}: ${detail.slice(0, 300)}`
      );
    }
    await response.body?.cancel().catch(() => {});
  }
}
