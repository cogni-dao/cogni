// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/observability.factory`
 * Purpose: Runtime wiring for the node-pinned observability-read proxies — builds a `LokiReaderPort`
 *   (Grafana read credential) and a `LangfuseReaderPort` (the operator's own Langfuse key). Lives in
 *   bootstrap so the app/route layer never imports adapters directly (no-restricted-imports).
 * Scope: Reads serverEnv; returns the adapter or `null` when the read credential is not wired (the
 *   route then fails graceful with 503 `observability_unwired`). No app logic here.
 * Invariants: NULL_WHEN_UNWIRED (read creds required); the operator holds the read credential, never the dev.
 * Side-effects: none beyond reading serverEnv
 * Links: src/adapters/server/observability/{loki-reader,langfuse-reader}.adapter.ts, src/ports/{loki-reader,langfuse-reader}.port.ts
 * @public
 */

import { HttpLangfuseReader, HttpLokiReader } from "@/adapters/server";
import type { LangfuseReaderPort, LokiReaderPort } from "@/ports";
import { serverEnv } from "@/shared/env";

/** The operator's Loki reader, or null when `GRAFANA_URL`/`GRAFANA_SERVICE_ACCOUNT_TOKEN` are unset. */
export function createLokiReader(): LokiReaderPort | null {
  const env = serverEnv();
  if (!env.GRAFANA_URL || !env.GRAFANA_SERVICE_ACCOUNT_TOKEN) {
    return null;
  }
  return new HttpLokiReader({
    grafanaUrl: env.GRAFANA_URL,
    token: env.GRAFANA_SERVICE_ACCOUNT_TOKEN,
  });
}

/** Langfuse Cloud default — the writer (LangfuseAdapter/SDK) falls back here when LANGFUSE_BASE_URL is unset. */
const LANGFUSE_DEFAULT_BASE_URL = "https://cloud.langfuse.com";

/**
 * The operator's Langfuse reader, or null when the Langfuse keys are unset. The base URL defaults to
 * Langfuse Cloud exactly as the trace-writing SDK does — so the reader is wired wherever the writer is
 * (the pod sets the keys but not always LANGFUSE_BASE_URL). The operator holds the key; the dev never does.
 */
export function createLangfuseReader(): LangfuseReaderPort | null {
  const env = serverEnv();
  if (!env.LANGFUSE_PUBLIC_KEY || !env.LANGFUSE_SECRET_KEY) {
    return null;
  }
  return new HttpLangfuseReader({
    baseUrl: env.LANGFUSE_BASE_URL ?? LANGFUSE_DEFAULT_BASE_URL,
    publicKey: env.LANGFUSE_PUBLIC_KEY,
    secretKey: env.LANGFUSE_SECRET_KEY,
  });
}
