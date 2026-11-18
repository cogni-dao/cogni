// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/node-approver-reader`
 * Purpose: Answer "which env-local users are this node's repo-spec approvers right now?" for the node-admin sync.
 * Scope: Interface only. One small seam that hides two things the sync must not know: how the repo-spec is
 *   read (GitHub App contents API only, 10 s deadline, never the public CDN) and how approver wallets map
 *   to users (the `users` wallet column, then wallet `user_bindings`).
 * Invariants:
 *   - APP_ONLY_READ: implementations never fall back to an anonymous or raw.githubusercontent read.
 *   - FRESH_READ: no cache (ttlMs 0). The sync's own tick is the only cadence.
 *   - UNAVAILABLE_IS_NOT_EMPTY: a failed read is `unavailable`; a readable-but-empty or malformed approver
 *     list is `read` with `approverCount` 0. The sync treats both as "write nothing", but logs them apart.
 * Side-effects: none (interface); implementations do IO.
 * Swap path: `@cogni-dao/agent-grants` 0.8.0 ships `createRepoSpecOwnerSource({ fetchRepoSpec,
 *   extractApprovers, usersForWallets, ttlMs: 0 }).owners({ kind: "repo-spec", ref })`. When it is
 *   published, the adapter delegates `approvers(node)` to that call; its three injected functions are
 *   exactly the three this adapter already takes, so the swap is a few lines.
 * Links: src/adapters/server/identity/repo-spec-node-approver-reader.adapter.ts, https://cognidao.org/knowledge/operator-identity-model, task.5494
 * @public
 */

/** Why a read was `unavailable`. A subset of the sync's closed reason enum, mirrored for the same layering reason. */
export type NodeApproverUnavailableReason =
  | "no_app_installation"
  | "timeout"
  | "not_found"
  | "user_lookup_failed"
  | "unexpected";

/**
 * What the reader learned about one node, already mapped from wallets to env-local user ids.
 * Mirrored (not imported) from `@shared/node-registry/node-admin-sync`: `ports` may not import `shared`.
 */
export type NodeApproverRead =
  | {
      readonly status: "unavailable";
      readonly reason: NodeApproverUnavailableReason;
    }
  | {
      readonly status: "read";
      /** Approver wallets listed in the repo-spec (0 when the list is empty or malformed). */
      readonly approverCount: number;
      /** Env-local user ids the approver wallets map to (may be fewer than `approverCount`). */
      readonly userIds: readonly string[];
    };

/**
 * The `nodes` row coordinates needed to find one node's repo-spec. Shaped like the agent-grants 0.8.0
 * repo-spec owner source `{ kind: "repo-spec", ref, path }`: a repo URL plus a path, never a path
 * folded into the URL.
 */
export interface NodeApproverTarget {
  readonly nodeId: string;
  /** Repo that holds the repo-spec: `https://github.com/<repo_owner>/<repo_name>`. */
  readonly repoUrl: string;
  /** Path of the repo-spec inside that repo (`nodes.repo_spec_path`). */
  readonly repoSpecPath: string;
}

export interface NodeApproverReader {
  /** Never throws: every failure is reported as `{ status: "unavailable" }`. */
  approvers(node: NodeApproverTarget): Promise<NodeApproverRead>;
}
