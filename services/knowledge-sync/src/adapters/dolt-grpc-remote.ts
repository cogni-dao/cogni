// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-sync-service/adapters/dolt-grpc-remote`
 * Purpose: LIVE DoltRemotePort — pushes a node's whole Doltgres knowledge DB to its
 *   DoltHub remote via `dolt_push` over the Doltgres SQL connection (GRPC under the hood).
 * Scope: One thin pusher. Lazy-adds the remote on first push, then `SELECT dolt_push(...)`.
 * Invariants:
 *   - Push/additive ONLY: `dolt_remote add` (idempotent) + `dolt_push` (no --force).
 *     Every emitted statement passes assertAdditive. A non-fast-forward push is
 *     rejected by the remote (safe) — we never force, reset, or drop.
 *   - Auth lives in the Doltgres SERVER (DOLT_CREDS_JWK via install-creds.sh), never here.
 *     The 2026-06-03 spike proved the DoltHub PAT HTTP write API silently no-ops; this
 *     GRPC path is the only one that lands commits on DoltHub.
 *   - `dolt_push` mirrors the entire DB (knowledge + work_items + all branches), not a subset.
 *   - Errors are translated to DoltRemotePortError; the caller drops them (best-effort).
 * Side-effects: IO (SQL against the knowledge DB; outbound GRPC to the remote)
 * Links: docs/runbooks/dolthub-remote-bootstrap.md,
 *        packages/knowledge-store/src/adapters/doltgres/dolt-remote.ts (operator's on-merge twin)
 * @public
 */

import type { Sql } from "postgres";

import {
  type DoltPushResult,
  type DoltRemotePort,
  DoltRemotePortError,
} from "../ports/dolt-remote.port.js";
import { assertAdditive, escapeRef, escapeValue } from "../sql/escape.js";

export interface DoltGrpcRemoteConfig {
  sql: Sql;
  node: string;
  /** Remote name (Dolt convention: "origin"). */
  remoteName: string;
  /** Full Dolt remote URL, e.g. https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator. */
  remoteUrl: string;
  branch: string;
}

export function createDoltGrpcRemoteAdapter(
  config: DoltGrpcRemoteConfig
): DoltRemotePort {
  const { sql, node, remoteName, remoteUrl, branch } = config;
  let remoteReady = false;

  async function run(
    statement: string,
    signal?: AbortSignal
  ): Promise<unknown> {
    assertAdditive(statement);
    const query = sql.unsafe(statement);
    if (!signal) return query;
    // postgres.js queries are thenables but not abortable; race a timeout so a
    // wedged push surfaces as an error instead of pinning the tick. The pool's
    // idle_timeout reclaims the underlying connection.
    return Promise.race([
      query,
      new Promise((_resolve, reject) => {
        if (signal.aborted) reject(new Error("push aborted (timeout)"));
        signal.addEventListener(
          "abort",
          () => reject(new Error("push aborted (timeout)")),
          { once: true }
        );
      }),
    ]);
  }

  async function ensureRemote(): Promise<void> {
    if (remoteReady) return;
    try {
      await run(
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
    kind: "grpc",
    async push(signal?: AbortSignal): Promise<DoltPushResult> {
      try {
        await ensureRemote();
        await run(
          `SELECT dolt_push(${escapeRef(remoteName)}, ${escapeRef(branch)})`,
          signal
        );
        return { node, remote: remoteUrl, branch };
      } catch (err) {
        throw new DoltRemotePortError("dolt_push failed", node, err);
      }
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}
