// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/remote-knowledge`
 * Purpose: The narrow read port git-review uses to read ANOTHER node's knowledge hub (task.5448).
 * Scope: Types only. It mirrors `RemoteKnowledgeCapability` and `RemoteKnowledgeError` of
 *   `@cogni-dao/ai-tools` (`createRemoteKnowledgeTransport`) so the operator depends on a port, not on
 *   the shared package release. The transport that implements it is built in
 *   `bootstrap/review/remote-knowledge.ts`.
 * Invariants:
 *   - ALIAS_NOT_URL: callers name an alias from `.cogni/service-links.yaml`; the transport owns the origin.
 *   - READ_ONLY: there is no write method.
 *   - FIXED_FAILURES: a failure is a `RemoteKnowledgeFailure` with one of five codes; no target body or
 *     header comes back through it.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/operator-identity-model (Git-review reviews a connected node)
 * @public
 */

import type { KnowledgeEntry } from "@cogni/ai-tools";

/** One listed node: the alias the tools name, the node id the assertion's `aud` carries, the https origin. */
export interface RemoteKnowledgeTarget {
  readonly alias: string;
  readonly nodeId: string;
  readonly origin: string;
}

export type RemoteKnowledgeFailureCode =
  | "unknown_alias"
  | "invalid_id"
  | "access_requested"
  | "policy_denied"
  | "unavailable";

/** A failed remote read: structurally the `RemoteKnowledgeError` of `@cogni-dao/ai-tools`. */
export interface RemoteKnowledgeFailure extends Error {
  readonly code: RemoteKnowledgeFailureCode;
}

const FAILURE_CODES: ReadonlySet<string> = new Set<RemoteKnowledgeFailureCode>([
  "unknown_alias",
  "invalid_id",
  "access_requested",
  "policy_denied",
  "unavailable",
]);

/** True for a `RemoteKnowledgeError` (matched by name and code, so a package copy never breaks it). */
export function isRemoteKnowledgeFailure(
  error: unknown
): error is RemoteKnowledgeFailure {
  if (!(error instanceof Error) || error.name !== "RemoteKnowledgeError")
    return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && FAILURE_CODES.has(code);
}

/** One governing-index row of the target's hub: routing metadata, never a body. */
export interface RemoteIndexRow {
  readonly id: string;
  readonly domain: string;
  readonly entryType: string;
  readonly useWhen: string;
}

export interface RemoteKnowledgeReadPort {
  /** The configured origin of an alias, or undefined when it is not configured. */
  originOf(alias: string): string | undefined;
  get(alias: string, id: string): Promise<KnowledgeEntry | null>;
  list(
    alias: string,
    params: { domain: string; limit: number }
  ): Promise<KnowledgeEntry[]>;
  search(
    alias: string,
    params: { domain: string; query: string; limit: number }
  ): Promise<KnowledgeEntry[]>;
  /**
   * The target's governing index. TODO(task.5448): `@cogni-dao/ai-tools` 0.16.0 adds
   * `index(alias, { domain?, q?, limit })`. Until the shared package is adopted (PR1) a transport built
   * from 0.15.0 has no `index`, so this is absent and the index read fails `unavailable`.
   */
  index?(
    alias: string,
    params: { domain?: string; q?: string; limit: number }
  ): Promise<readonly unknown[]>;
}
