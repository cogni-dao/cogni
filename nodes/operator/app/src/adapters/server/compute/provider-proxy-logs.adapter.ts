// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/compute/provider-proxy-logs.adapter`
 * Purpose: Read one Akash lease's current log window through the Console provider-proxy
 *   (bug.5240). The proxy performs on-chain provider TLS validation we must not re-implement
 *   (provider gateways run self-signed certs); this client sends ONE bounded
 *   `POST {proxy} {method:"GET", url:<hostUri>/lease/<dseq>/<gseq>/<oseq>/logs, auth:jwt}`
 *   and parses the NDJSON `{name, message}` window the provider returns.
 * Scope: HTTP IO + line parsing only. Which leases to read, how often, and what the lines
 *   mean is the pump's business.
 * Invariants:
 *   - EPHEMERAL_TOKEN_PER_CALL: the logs-scoped JWT arrives per call and is never stored.
 *   - FOLLOW_IS_FORBIDDEN_HERE: always `follow=false` — a bounded snapshot per poll. A held
 *     stream through the proxy is an availability liability the poll-merge design avoids.
 *   - MALFORMED_LINES_SURVIVE: an unparseable NDJSON row ships as a raw message on the
 *     lease's own name rather than being dropped — diagnosis data is never discarded.
 * Side-effects: IO (HTTPS POST to the Console provider-proxy)
 * Links: @ports/lease-log.port, features/compute/lease-log-pump/lease-log-pump.ts,
 *   github.com/akash-network/console apps/provider-proxy (proxyProviderRequest schema),
 *   bug.5240, task.5144
 * @internal
 */

import type { ProviderLeaseLogLine, ProviderLeaseLogReaderPort } from "@/ports";

export interface ProviderProxyLogsConfig {
  /** Provider-proxy base, e.g. `https://console.akash.network/provider-proxy-mainnet`. */
  readonly proxyUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Per-request budget; the proxy caps per-attempt timeout at 30s. */
  readonly timeoutMs?: number;
}

export class ProviderProxyLogsClient implements ProviderLeaseLogReaderPort {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: ProviderProxyLogsConfig) {
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  async read(input: {
    readonly providerHostUri: string;
    readonly providerAccount: string;
    readonly dseq: string;
    readonly gseq: number;
    readonly oseq: number;
    readonly token: string;
    readonly tail: number;
  }): Promise<readonly ProviderLeaseLogLine[]> {
    const base = input.providerHostUri.replace(/\/+$/, "");
    const leaseLogsUrl =
      `${base}/lease/${encodeURIComponent(input.dseq)}/${input.gseq}/` +
      `${input.oseq}/logs?follow=false&tail=${input.tail}`;
    const response = await this.fetchImpl(
      `${this.config.proxyUrl.replace(/\/+$/, "")}/`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method: "GET",
          url: leaseLogsUrl,
          providerAddress: input.providerAccount,
          auth: { type: "jwt", token: input.token },
          timeout: Math.min(this.timeoutMs, 29_000),
        }),
        signal: AbortSignal.timeout(this.timeoutMs + 5_000),
      }
    );
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `provider-proxy logs read failed with HTTP ${response.status}: ` +
          detail.slice(0, 300)
      );
    }
    const text = await response.text();
    return parseLeaseLogWindow(text, `dseq-${input.dseq}`);
  }
}

/** Parse an NDJSON lease-log window. Exported for tests. */
export function parseLeaseLogWindow(
  text: string,
  fallbackName: string
): readonly ProviderLeaseLogLine[] {
  const lines: ProviderLeaseLogLine[] = [];
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "") continue;
    try {
      const parsed = JSON.parse(trimmed) as {
        name?: unknown;
        message?: unknown;
      };
      if (typeof parsed.message === "string") {
        lines.push({
          name: typeof parsed.name === "string" ? parsed.name : fallbackName,
          message: parsed.message,
        });
        continue;
      }
    } catch {
      // fall through: ship the raw row under the lease's own name
    }
    lines.push({ name: fallbackName, message: trimmed });
  }
  return lines;
}
