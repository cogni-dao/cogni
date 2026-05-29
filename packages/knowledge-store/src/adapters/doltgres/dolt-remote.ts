// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/dolt-remote`
 * Purpose: Fire-and-forget push of the knowledge DB's `main` branch to a Dolt remote (typically DoltHub).
 * Scope: One thin factory. Lazy-adds the remote on first push, then issues `SELECT dolt_push(...)`. Does not contain HTTP, cred management, retry/backoff, or logging — those belong to the caller (operator DI).
 * Invariants:
 *   - Push happens AFTER the merge transaction commits; never holds the merge connection open.
 *   - Auth lives in the doltgres process state (DOLT creds file, see docs/runbooks/dolthub-remote-bootstrap.md). The SQL surface here knows nothing about credentials.
 *   - Errors propagate to the caller; the caller (operator container DI) wraps with `.catch(log)` to keep push best-effort.
 * Side-effects: IO (SQL against the knowledge DB; outbound GRPC to the remote)
 * Links: docs/runbooks/dolthub-remote-bootstrap.md, work/projects/proj.knowledge-syntropy.md
 * @public
 */

import type { Sql } from "postgres";
import { escapeRef, escapeValue } from "./util.js";

export interface DoltgresPushConfig {
  sql: Sql;
  /** Remote name (Dolt convention: "origin"). */
  remoteName: string;
  /** Full Dolt remote URL, e.g. `https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator`. */
  remoteUrl: string;
  /** Branch to push. Defaults to "main". */
  branch?: string;
}

export interface DoltgresPusher {
  /** Push the configured branch to the configured remote. Throws on any failure. */
  pushBranch(): Promise<void>;
}

/**
 * Build a pusher. The first `pushBranch()` call lazily ensures the remote
 * is registered in the Doltgres DB; subsequent calls skip the add.
 *
 * Idempotency: `dolt_remote('add', ...)` against an existing remote errors
 * with "remote already exists" — we swallow that one case so re-runs are safe.
 * Any other error during add is fatal.
 */
export function createDoltgresPusher(
  config: DoltgresPushConfig
): DoltgresPusher {
  const { sql, remoteName, remoteUrl } = config;
  const branch = config.branch ?? "main";
  let remoteReady = false;

  async function ensureRemote(): Promise<void> {
    if (remoteReady) return;
    try {
      await sql.unsafe(
        `SELECT dolt_remote('add', ${escapeValue(remoteName)}, ${escapeValue(remoteUrl)})`
      );
    } catch (e: unknown) {
      const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
      if (!msg.includes("already exists") && !msg.includes("remote exists")) {
        throw e;
      }
    }
    remoteReady = true;
  }

  return {
    async pushBranch(): Promise<void> {
      await ensureRemote();
      await sql.unsafe(
        `SELECT dolt_push(${escapeRef(remoteName)}, ${escapeRef(branch)})`
      );
    },
  };
}

/**
 * Callbacks fired at the end of `wrapPushSafe`'s attempt. The caller supplies
 * its own logger bindings here — this keeps the adapter framework-agnostic
 * (no Pino/Winston import) while still letting the operator container surface
 * push outcomes structurally to Loki.
 */
export interface PushOutcomeListener {
  onSuccess: () => void;
  onFailure: (err: unknown) => void;
}

/**
 * Convert a `DoltgresPusher` into a fire-and-forget function suitable for
 * `ContributionServiceDeps.pushMainOnMerge`. Catches every error so it never
 * bubbles up to the merge response; routes outcomes to the listener.
 *
 * This is the only wiring layer in the push job that knows about
 * success-vs-failure observability semantics — keeping it pure + injectable
 * means it can be tested without spinning up Pino, postgres.js, or Doltgres.
 */
export function wrapPushSafe(
  pusher: DoltgresPusher,
  listener: PushOutcomeListener
): () => Promise<void> {
  return async () => {
    try {
      await pusher.pushBranch();
      listener.onSuccess();
    } catch (err) {
      listener.onFailure(err);
    }
  };
}
