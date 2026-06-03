// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/adapters/doltgres/dolt-remote`
 * Purpose: Mirror the knowledge DB's `main` branch with a Dolt remote (typically DoltHub) — push after merges, and seed-on-boot so a freshly-initialized DB shares ancestry with the remote.
 * Scope: Two thin factories over the `dolt_*` SQL surface. Lazy-adds the remote on first use, then `dolt_push` (pusher) or `dolt_fetch` + conditional `dolt_reset` (puller). Does not contain HTTP, cred management, retry/backoff, or logging — those belong to the caller (operator DI).
 * Invariants:
 *   - Push happens AFTER the merge transaction commits; never holds the merge connection open.
 *   - The puller runs once at boot, before the knowledge store serves traffic. Its only job is to make local `main` descend from `origin/main` — a no-op when it already does.
 *   - Auth lives in the doltgres process state (DOLT creds file, see docs/runbooks/dolthub-remote-bootstrap.md). The SQL surface here knows nothing about credentials.
 *   - Errors propagate to the caller; the caller (operator container DI) wraps push with `wrapPushSafe` and seed with a boot try/catch to keep both best-effort.
 * Side-effects: IO (SQL against the knowledge DB; outbound GRPC to the remote)
 * Links: docs/runbooks/dolthub-remote-bootstrap.md, work/projects/proj.knowledge-syntropy.md
 * @public
 */

import type { Sql } from "postgres";
import { escapeRef, escapeValue } from "./util.js";

/**
 * Lazily register the remote. `dolt_remote('add', ...)` against an existing
 * remote errors with "remote already exists" — we swallow that one case so
 * re-runs (and a pusher + puller sharing the same remote) are safe. Any other
 * error during add is fatal.
 */
async function ensureRemoteRegistered(
  sql: Sql,
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
}

export interface DoltgresPuller {
  /**
   * Make local `branch` descend from `remoteName/branch`. Idempotent:
   * a no-op when the local branch already shares history with the remote,
   * an adopt-remote-history reset when it does not (the fresh-node case).
   */
  seedFromRemote(): Promise<void>;
}

/**
 * Build a seeder. A freshly-provisioned node's migrator initializes an empty
 * knowledge DB whose commit graph has no common ancestor with the remote — so
 * the post-merge pusher can never push ("no common ancestor"), and the node
 * starts with zero knowledge. `seedFromRemote()` closes that gap on boot:
 *
 *   1. lazy `dolt_remote add` (idempotent)
 *   2. `dolt_fetch` to populate the `origin/<branch>` tracking ref
 *   3. if local `<branch>` shares no history with `origin/<branch>`,
 *      `dolt_reset --hard origin/<branch>` — adopt the remote's history,
 *      pulling its schema + data and establishing shared ancestry.
 *
 * On a node that already descends from the remote, step 3 is skipped (the
 * merge-base check is non-empty) so re-running on every boot is harmless.
 * `dolt_reset --hard` discards the migrator's throwaway init commits in favor
 * of the canonical remote history; the remote carries the same migrator schema
 * plus the accumulated knowledge, so nothing is lost.
 */
export function createDoltgresPuller(
  config: DoltgresPullConfig
): DoltgresPuller {
  const { sql, remoteName, remoteUrl } = config;
  const branch = config.branch ?? "main";
  const remoteRef = `${remoteName}/${branch}`;

  async function sharesHistory(): Promise<boolean> {
    // dolt_merge_base returns the common-ancestor commit hash, or an empty
    // value when the two refs have unrelated histories. Some Doltgres versions
    // error on fully-unrelated refs — treat any error as "no shared history".
    try {
      const rows = await sql.unsafe(
        `SELECT dolt_merge_base(${escapeValue(branch)}, ${escapeValue(remoteRef)}) AS base`
      );
      const base = (rows[0] as Record<string, unknown> | undefined)?.base;
      return typeof base === "string" && base.length > 0;
    } catch {
      return false;
    }
  }

  return {
    async seedFromRemote(): Promise<void> {
      await ensureRemoteRegistered(sql, remoteName, remoteUrl);
      await sql.unsafe(`SELECT dolt_fetch(${escapeRef(remoteName)})`);
      if (!(await sharesHistory())) {
        await sql.unsafe(`SELECT dolt_reset('--hard', ${escapeRef(remoteRef)})`);
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
