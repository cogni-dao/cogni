// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/identity/repo-spec-node-approver-reader`
 * Purpose: `NodeApproverReader` over a node's repo-spec: read the file through the GitHub App, extract
 *   the approver wallets, map them to env-local user ids.
 * Scope: Composes three injected functions: `fetchRepoSpec`, `extractApprovers`, `usersForWallets`. These are
 *   the same three options `@cogni-dao/agent-grants` `createRepoSpecOwnerSource` takes, so swapping this
 *   class for that package (0.8.0, `ttlMs: 0`) is a few lines in `approvers()`. Also ships the default
 *   `extractApprovers` and the Drizzle `usersForWallets`.
 * Invariants:
 *   - APP_ONLY_READ: the injected `fetchRepoSpec` must use the GitHub App contents API. The bootstrap
 *     wiring passes the operator App writer, never `AppOrPublicDeclarationReader`.
 *   - READ_DEADLINE: one node's read is abandoned after `READ_TIMEOUT_MS` (10 s) and reported `unavailable`.
 *   - NEVER_THROWS: every failure path is `{ status: "unavailable", reason }` with a closed reason; a malformed spec is `approverCount: 0`.
 *   - WALLETS_ARE_LOWERCASE: approvers are lowercased before lookup and compared case-insensitively.
 *   - USERS_COLUMN_FIRST: a wallet maps to the `users.wallet_address` row when one exists, else to a wallet
 *     `user_bindings` row. A wallet never maps to two users.
 * Side-effects: IO (GitHub App read, PostgreSQL read through the injected service-role database).
 * Links: src/ports/node-approver-reader.port.ts, https://cognidao.org/knowledge/operator-identity-model, task.5494
 * @public
 */

import type { Database } from "@cogni/db-client";
import { extractLedgerApprovers, parseRepoSpec } from "@cogni/repo-spec";
import { and, eq, inArray, sql } from "drizzle-orm";

import type {
  NodeApproverRead,
  NodeApproverReader,
  NodeApproverTarget,
  NodeApproverUnavailableReason,
} from "@/ports";
import { userBindings, users } from "@/shared/db/schema";

/** Per-node deadline for the repo-spec read. */
export const READ_TIMEOUT_MS = 10_000;

/** `error.code` the GitHub App reader sets when the App is not installed on a repo. */
const GITHUB_APP_NOT_INSTALLED_CODE = "github_app_not_installed";

/**
 * Thrown by the read deadline, and by wiring that cannot reach the App at all, so the reader can
 * report a closed `reason` instead of a bare `unavailable`.
 */
export class NodeApproverReadError extends Error {
  constructor(
    readonly reason: NodeApproverUnavailableReason,
    message: string
  ) {
    super(message);
    this.name = "NodeApproverReadError";
  }
}

function unavailable(reason: NodeApproverUnavailableReason): NodeApproverRead {
  return { status: "unavailable", reason };
}

function classifyReadError(error: unknown): NodeApproverUnavailableReason {
  if (error instanceof NodeApproverReadError) return error.reason;
  if ((error as { code?: unknown })?.code === GITHUB_APP_NOT_INSTALLED_CODE) {
    return "no_app_installation";
  }
  return "unexpected";
}

export interface RepoSpecNodeApproverReaderDeps {
  /** Read `path` in the repo at URL `ref`, at the default-branch head, through the GitHub App only. Null when absent. Same call shape as agent-grants `fetchRepoSpec(ref, path)`. */
  readonly fetchRepoSpec: (ref: string, path: string) => Promise<string | null>;
  /** Parse the repo-spec text and return its approver wallets. Throws when malformed. */
  readonly extractApprovers: (repoSpecText: string) => readonly string[];
  /** Map lowercase wallets to env-local user ids. Wallets with no user are simply absent. */
  readonly usersForWallets: (
    wallets: readonly string[]
  ) => Promise<readonly string[]>;
  readonly readTimeoutMs?: number;
}

export class RepoSpecNodeApproverReader implements NodeApproverReader {
  constructor(private readonly deps: RepoSpecNodeApproverReaderDeps) {}

  async approvers(node: NodeApproverTarget): Promise<NodeApproverRead> {
    let text: string | null;
    try {
      text = await withDeadline(
        this.deps.fetchRepoSpec(node.repoUrl, node.repoSpecPath),
        this.deps.readTimeoutMs ?? READ_TIMEOUT_MS
      );
    } catch (error) {
      return unavailable(classifyReadError(error));
    }
    if (text === null) return unavailable("not_found");

    let wallets: string[];
    try {
      wallets = [
        ...new Set(
          this.deps.extractApprovers(text).map((wallet) => wallet.toLowerCase())
        ),
      ];
    } catch {
      // Readable but not a valid repo-spec: the approver list is malformed, i.e. empty.
      return { status: "read", approverCount: 0, userIds: [] };
    }
    if (wallets.length === 0) {
      return { status: "read", approverCount: 0, userIds: [] };
    }

    try {
      const userIds = await this.deps.usersForWallets(wallets);
      return {
        status: "read",
        approverCount: wallets.length,
        userIds: [...new Set(userIds)],
      };
    } catch {
      return unavailable("user_lookup_failed");
    }
  }
}

/** Default `extractApprovers`: the repo-spec's `activity_ledger.approvers`, lowercased. */
export function extractRepoSpecApprovers(repoSpecText: string): string[] {
  return extractLedgerApprovers(parseRepoSpec(repoSpecText));
}

/**
 * Default `usersForWallets` over the service-role database. SIWE users carry the wallet on
 * `users.wallet_address`; wallet `user_bindings` cover users who linked a wallet later.
 */
export function drizzleUsersForWallets(
  db: Database
): RepoSpecNodeApproverReaderDeps["usersForWallets"] {
  return async (wallets) => {
    if (wallets.length === 0) return [];
    const byUsersColumn = await db
      .select({ id: users.id, wallet: users.walletAddress })
      .from(users)
      .where(inArray(sql<string>`lower(${users.walletAddress})`, [...wallets]));
    const mapped = new Map<string, string>();
    for (const row of byUsersColumn) {
      if (row.wallet) mapped.set(row.wallet.toLowerCase(), row.id);
    }

    const unmapped = wallets.filter((wallet) => !mapped.has(wallet));
    if (unmapped.length > 0) {
      const byBinding = await db
        .select({ id: userBindings.userId, wallet: userBindings.externalId })
        .from(userBindings)
        .where(
          and(
            eq(userBindings.provider, "wallet"),
            inArray(sql<string>`lower(${userBindings.externalId})`, unmapped)
          )
        );
      for (const row of byBinding) {
        const wallet = row.wallet.toLowerCase();
        if (!mapped.has(wallet)) mapped.set(wallet, row.id);
      }
    }
    return [...mapped.values()];
  };
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new NodeApproverReadError(
            "timeout",
            `repo-spec read timed out after ${timeoutMs}ms`
          )
        ),
      timeoutMs
    );
  });
  // The abandoned read may still reject later; swallow it so it is not an unhandled rejection.
  promise.catch(() => {});
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
