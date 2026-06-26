// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/observability/langfuse-reader.adapter`
 * Purpose: HTTP adapter for `LangfuseReaderPort` — lists a node's traces via the Langfuse public API
 *   (`GET /api/public/traces`) with the operator's Langfuse key, pinned to `tags=<nodeId>` (same key
 *   the decorator writes with; same shape as `pnpm langfuse:trace`).
 * Scope: IO only. Credentials/URL are constructor inputs (no env loading here — bootstrap wires them).
 * Invariants: READ_ONLY (GET /traces); KEY_NEVER_LOGGED (no key in errors/logs).
 * Side-effects: network (fetch to Langfuse)
 * Links: src/ports/langfuse-reader.port.ts, src/bootstrap/observability.factory.ts
 * @public
 */

import type {
  LangfuseReaderPort,
  LangfuseTraceQuery,
  LangfuseTraceSummary,
} from "@/ports";

export class HttpLangfuseReader implements LangfuseReaderPort {
  private readonly base: string;
  private readonly authHeader: string;

  constructor(opts: { baseUrl: string; publicKey: string; secretKey: string }) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    // Langfuse public API uses HTTP Basic: publicKey as user, secretKey as password.
    this.authHeader = `Basic ${Buffer.from(
      `${opts.publicKey}:${opts.secretKey}`
    ).toString("base64")}`;
  }

  async listTraces(query: LangfuseTraceQuery): Promise<LangfuseTraceSummary[]> {
    const url = new URL(`${this.base}/api/public/traces`);
    // NODE_PIN: the nodeId tag is the per-node read boundary — caller cannot widen it.
    url.searchParams.set("tags", query.nodeId);
    url.searchParams.set("limit", String(query.limit));
    if (query.environment) {
      url.searchParams.set("environment", query.environment);
    }

    const res = await fetch(url, {
      headers: { Authorization: this.authHeader },
      // Bound the call so a hung upstream can't pin the route.
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      // Never echo the key; include status + a short body excerpt for diagnosis.
      const body = (await res.text().catch(() => "")).slice(0, 200);
      throw new Error(
        `langfuse list traces failed: HTTP ${res.status} ${body}`
      );
    }

    const json = (await res.json()) as LangfuseTracesResponse;
    const rows = json.data ?? [];
    return rows.map((t) => ({
      id: t.id,
      name: t.name ?? null,
      timestamp: t.timestamp,
      tags: t.tags ?? [],
      nodeId: typeof t.metadata?.nodeId === "string" ? t.metadata.nodeId : null,
    }));
  }
}

interface LangfuseTracesResponse {
  readonly data?: ReadonlyArray<{
    readonly id: string;
    readonly timestamp: string;
    readonly name?: string | null;
    readonly tags?: readonly string[];
    readonly metadata?: { readonly nodeId?: unknown } | null;
  }>;
}
