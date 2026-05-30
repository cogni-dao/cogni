// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@/lib/governance-boot-sync`
 * Purpose: Node self-registers its governance + ledger(epoch) Temporal schedules at startup.
 * Scope: Pure fetch + bounded-retry trigger of the existing internal sync endpoint. Holds NO sync logic and imports NO bootstrap/container wiring (so `instrumentation.ts` may import it without violating the instrumentation→bootstrap dep-cruiser rule). Self-contained pino logger for the same reason.
 * Invariants:
 *   - DISABLED_IS_NOOP: skips when GOVERNANCE_SCHEDULES_ENABLED=false or INTERNAL_OPS_TOKEN unset
 *   - FAIL_SOFT_BOOT: never throws to the caller; logs loudly and returns
 *   - IDEMPOTENT: endpoint is pg_advisory_lock-guarded; safe to call on every boot/replica
 *   - SYSTEM_OPS_ONLY: authenticates with INTERNAL_OPS_TOKEN; self-call over loopback only
 * Side-effects: IO (HTTP POST to own internal endpoint), structured log
 * Notes: Replaces the deploy-time trigger (removed `scripts/ci/deploy.sh` Step 10.1) with a
 *   node-owned boot trigger so a forked node works without operator/deploy-pipeline help.
 * Links: docs/spec/governance-scheduling.md, src/app/api/internal/ops/governance/schedules/sync/route.ts
 * @public
 */

import pino from "pino";

const SYNC_ROUTE = "/api/internal/ops/governance/schedules/sync";
const DEFAULT_MAX_ATTEMPTS = 12;
const DEFAULT_BASE_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface GovernanceBootSyncConfig {
  /** Loopback port the app's HTTP server listens on. */
  port: number;
  /** Internal ops bearer token; null/empty disables the sync. */
  token: string | null;
  /** False when GOVERNANCE_SCHEDULES_ENABLED=false (preview safety). */
  enabled: boolean;
}

export interface GovernanceBootSyncDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  logger?: Pick<pino.Logger, "info" | "warn" | "error">;
  maxAttempts?: number;
  baseDelayMs?: number;
}

/** Resolve config straight from process.env (instrumentation runs before the env framework). */
export function resolveBootSyncConfig(
  env: NodeJS.ProcessEnv
): GovernanceBootSyncConfig {
  return {
    port: Number(env.PORT ?? 3000),
    token: env.INTERNAL_OPS_TOKEN ?? null,
    enabled: env.GOVERNANCE_SCHEDULES_ENABLED !== "false",
  };
}

function defaultLogger(): Pick<pino.Logger, "info" | "warn" | "error"> {
  return pino({
    base: {
      app: "cogni-template",
      // biome-ignore lint/style/noProcessEnv: boot log emitted before the config framework
      service: process.env.SERVICE_NAME ?? "app",
      component: "governance-boot-sync",
    },
    messageKey: "msg",
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

/**
 * Trigger governance schedule sync against the app's own internal endpoint, retrying
 * while the HTTP server is still coming up. Never throws.
 */
export async function runGovernanceBootSync(
  config: GovernanceBootSyncConfig,
  deps: GovernanceBootSyncDeps = {}
): Promise<void> {
  const log = deps.logger ?? defaultLogger();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseDelayMs = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;

  if (!config.enabled) {
    log.info(
      { reason: "GOVERNANCE_SCHEDULES_ENABLED=false" },
      "governance boot-sync skipped"
    );
    return;
  }
  if (!config.token) {
    log.warn(
      { reason: "INTERNAL_OPS_TOKEN unset" },
      "governance boot-sync skipped — schedules will NOT register; epochs cannot start"
    );
    return;
  }

  const url = `http://127.0.0.1:${config.port}${SYNC_ROUTE}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { authorization: `Bearer ${config.token}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.ok || res.status === 204) {
        log.info(
          { status: res.status, attempt },
          "governance schedules synced at boot"
        );
        return;
      }
      // 4xx is a real misconfig (bad token, disabled) — retrying won't help.
      if (res.status >= 400 && res.status < 500) {
        log.error(
          { status: res.status },
          "governance boot-sync rejected (4xx) — check INTERNAL_OPS_TOKEN; schedules NOT registered"
        );
        return;
      }
      log.warn(
        { status: res.status, attempt },
        "governance boot-sync non-OK response, retrying"
      );
    } catch (err) {
      // ECONNREFUSED is expected while the HTTP server is still binding — retry.
      log.warn(
        { attempt, err: err instanceof Error ? err.message : String(err) },
        "governance boot-sync endpoint not ready, retrying"
      );
    }

    if (attempt < maxAttempts) {
      await sleep(baseDelayMs * attempt);
    }
  }

  log.error(
    { maxAttempts },
    "governance boot-sync FAILED after retries — schedules NOT registered; epochs/governance will not start"
  );
}
