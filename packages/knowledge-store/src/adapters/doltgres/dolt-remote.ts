// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/dolt-remote`
 * Purpose: Mirror the knowledge DB's `main` branch with a Dolt remote (typically DoltHub) — push after merges, and seed-on-boot so a freshly-initialized DB shares ancestry with the remote.
 * Scope: Two thin factories over the `dolt_*` SQL surface. Lazy-adds the remote on first use, then `dolt_push` (pusher) or `dolt_fetch` + conditional `dolt_reset` (puller). Does not contain HTTP, cred management, retry/backoff, or logging — those belong to the caller (operator DI).
 * Invariants:
 *   - Push happens AFTER the merge transaction commits; never holds the merge connection open.
 *   - The puller runs once as a floating boot task. Its only job is to make local `main` descend from `origin/main` — a no-op when it already does.
 *   - Auth lives in the doltgres process state (DOLT creds file, see docs/runbooks/dolthub-remote-bootstrap.md). The SQL surface here knows nothing about credentials.
 *   - Errors propagate to the caller; the caller (operator container DI) wraps push with `wrapPushSafe` and the seed with a boot `.catch`, keeping both best-effort.
 * Side-effects: IO (SQL against the knowledge DB; outbound GRPC to the remote)
 * Links: docs/runbooks/dolthub-remote-bootstrap.md, work/projects/proj.knowledge-syntropy.md
 * @public
 */

import type { ReservedSql, Sql } from "postgres";
import { escapeRef, escapeValue } from "./util.js";

/**
 * Lazily register the remote. `dolt_remote('add', ...)` against an existing
 * remote errors with "remote already exists" — we swallow that one case so
 * re-runs (and a pusher + puller sharing the same remote) are safe. Any other
 * error during add is fatal.
 */
async function ensureRemoteRegistered(
  sql: Sql | ReservedSql,
  remoteName: string,
  remoteUrl: string
): Promise<void> {
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
}

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
 */
export function createDoltgresPusher(
  config: DoltgresPushConfig
): DoltgresPusher {
  const { sql, remoteName, remoteUrl } = config;
  const branch = config.branch ?? "main";
  let remoteReady = false;

  return {
    async pushBranch(): Promise<void> {
      if (!remoteReady) {
        await ensureRemoteRegistered(sql, remoteName, remoteUrl);
        remoteReady = true;
      }
      await sql.unsafe(
        `SELECT dolt_push(${escapeRef(remoteName)}, ${escapeRef(branch)})`
      );
    },
  };
}

export interface DoltgresPullConfig {
  sql: Sql;
  /** Remote name (Dolt convention: "origin"). */
  remoteName: string;
  /** Full Dolt remote URL — same value the pusher uses. */
  remoteUrl: string;
  /** Branch to seed. Defaults to "main". */
  branch?: string;
  /**
   * Safety gate for the destructive `reset --hard`. Called on the reserved
   * connection ONLY when local has no shared history with the remote, i.e.
   * right before the adopt-remote reset would fire. Return `false` to refuse
   * the reset (seed becomes a no-op, "skipped_unsafe").
   *
   * This DB is shared — `reset --hard` would adopt the remote's version of
   * EVERY table, including the operator's `work_items`. The caller injects a
   * pristine check here (e.g. "work_items is empty") so the seed only adopts
   * remote history into a genuinely fresh node and can never clobber a node
   * that has accumulated local operational data. Omitted ⇒ always adopt.
   */
  canAdoptRemoteHistory?: (conn: ReservedSql) => Promise<boolean>;
}

/**
 * What `seedFromRemote` did. Returned (rather than logged in the adapter) so
 * the caller can surface it structurally — e.g. distinguishing a fresh-node
 * reset from a steady-state no-op in Loki without the adapter importing a logger.
 */
export type SeedAction = "reset" | "noop" | "skipped_unsafe";

export interface DoltgresPuller {
  /**
   * Make local `branch` descend from `remoteName/branch`. Idempotent:
   * `"noop"` when the local branch already shares history with the remote;
   * `"reset"` when it does not and `canAdoptRemoteHistory` allows (the
   * fresh-node case) — adopts remote history; `"skipped_unsafe"` when there
   * is no shared history but the guard refused (local has data to protect).
   */
  seedFromRemote(): Promise<SeedAction>;
}

/**
 * Build a seeder. A freshly-provisioned node's migrator initializes an empty
 * Dolt DB whose commit graph has no common ancestor with the remote — so the
 * post-merge pusher can never push ("no common ancestor"), and the node starts
 * with no data. `seedFromRemote()` closes that gap on boot:
 *
 *   1. lazy `dolt_remote add` (idempotent)
 *   2. `dolt_fetch(remote, branch)` — explicit branch refspec, so ALL of the
 *      branch's data chunks come down, not just the commit graph. (A bare
 *      `dolt_fetch(remote)` can leave the working tree referencing chunks that
 *      were never transferred, which then panics on read — "empty chunk
 *      returned from ChunkStore" — after the reset below.)
 *   3. if local `<branch>` shares no history with `origin/<branch>`,
 *      `dolt_reset --hard origin/<branch>` — adopt the remote's history,
 *      pulling its schema + data and establishing shared ancestry.
 *
 * The whole sequence runs on ONE reserved connection so the fetch's chunks and
 * the reset's branch move are pinned to a single Dolt session (the same pattern
 * the contribution adapter uses for its `dolt_checkout`-stateful branch ops).
 *
 * On a node that already descends from the remote, step 3 is skipped (the
 * merge-base check is non-empty) so re-running on every boot is harmless.
 *
 * NOTE — this DB is shared: on the operator it holds `work_items` alongside
 * `knowledge`/`citations`/contributions, and `dolt_reset --hard` adopts the
 * remote's version of EVERY table. Two independent guards keep that safe:
 *   - prod (the pusher) shares history → step 3 is skipped (no-op), so a
 *     populated node is never reset.
 *   - `canAdoptRemoteHistory` gates step 3 for the no-shared-history case, so
 *     the reset only fires into a pristine DB (caller checks `work_items` is
 *     empty). A node that accumulated operational data without ever sharing
 *     history — exactly the "no common ancestor" target — is left untouched
 *     ("skipped_unsafe") rather than having its work items clobbered.
 */
export function createDoltgresPuller(
  config: DoltgresPullConfig
): DoltgresPuller {
  const { sql, remoteName, remoteUrl, canAdoptRemoteHistory } = config;
  const branch = config.branch ?? "main";
  const remoteRef = `${remoteName}/${branch}`;

  async function sharesHistory(conn: ReservedSql): Promise<boolean> {
    // dolt_merge_base returns the common-ancestor commit hash, or an empty
    // value when the two refs have unrelated histories. Some Doltgres versions
    // error on fully-unrelated refs — treat any error as "no shared history".
    // When a base DOES exist (incl. local-ahead-of-remote), the call returns it
    // and never errors, so the destructive reset below cannot fire on a node
    // that merely has unpushed commits — only on genuinely unrelated histories.
    try {
      const rows = await conn.unsafe(
        `SELECT dolt_merge_base(${escapeValue(branch)}, ${escapeValue(remoteRef)}) AS base`
      );
      const base = (rows[0] as Record<string, unknown> | undefined)?.base;
      return typeof base === "string" && base.length > 0;
    } catch {
      return false;
    }
  }

  return {
    async seedFromRemote(): Promise<SeedAction> {
      const conn = await sql.reserve();
      try {
        await ensureRemoteRegistered(conn, remoteName, remoteUrl);
        await conn.unsafe(
          `SELECT dolt_fetch(${escapeRef(remoteName)}, ${escapeRef(branch)})`
        );
        if (await sharesHistory(conn)) {
          return "noop";
        }
        if (canAdoptRemoteHistory && !(await canAdoptRemoteHistory(conn))) {
          return "skipped_unsafe";
        }
        await conn.unsafe(
          `SELECT dolt_reset('--hard', ${escapeRef(remoteRef)})`
        );
        return "reset";
      } finally {
        conn.release();
      }
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
