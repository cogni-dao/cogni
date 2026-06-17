// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/observability.factory`
 * Purpose: Runtime wiring for the node-pinned log-read proxy — builds a `LokiReaderPort` from the
 *   operator's own Grafana read credential (`GRAFANA_URL` + `GRAFANA_SERVICE_ACCOUNT_TOKEN`). Lives in
 *   bootstrap so the app/route layer never imports adapters directly (no-restricted-imports).
 * Scope: Reads serverEnv; returns the adapter or `null` when the read credential is not wired (the
 *   route then fails graceful with 503 `observability_unwired`). No app logic here.
 * Invariants: NULL_WHEN_UNWIRED (both env values required); the operator holds the read token, never the dev.
 * Side-effects: none beyond reading serverEnv
 * Links: src/adapters/server/observability/loki-reader.adapter.ts, src/ports/loki-reader.port.ts
 * @public
 */

import { HttpLokiReader } from "@/adapters/server";
import type { LokiReaderPort } from "@/ports";
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
