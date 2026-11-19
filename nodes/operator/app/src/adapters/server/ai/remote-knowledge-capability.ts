// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/remote-knowledge-capability`
 * Purpose: Adapt the read port of ANOTHER node's hub to the `KnowledgeCapability` the stock knowledge
 *   tools take, for one alias (task.5448). A review of a connected node binds its `knowledge_read`,
 *   `knowledge_search` and `knowledge_index` tools to this, never to the operator's own hub.
 * Scope: Pure adaptation plus the typed mapping of a remote failure to an execution error code. No IO of
 *   its own; the port owns the signed fetch.
 * Invariants:
 *   - READ_ONLY: `write` throws; there is no goal reader.
 *   - ERRORS_PASS_THROUGH: a failure from the port is thrown unchanged, so the tool runner still sees the
 *     port error's non-retryable receipt for `policy_denied`.
 *   - NO_OPERATOR_FALLBACK: nothing here reaches the operator's Doltgres.
 *   - ONE_INDEX_SEAM: the target's index is read in `readIndexRows` only (TODO(task.5448) below).
 * Side-effects: none
 * Links: src/ports/remote-knowledge.port.ts, https://cognidao.org/knowledge/operator-identity-model
 * @internal
 */

import { AiExecutionError, type AiExecutionErrorCode } from "@cogni/ai-core";
import type {
  GoverningIndexEntry,
  KnowledgeCapability,
  KnowledgeEntry,
} from "@cogni/ai-tools";
import {
  isRemoteKnowledgeFailure,
  type RemoteIndexRow,
  type RemoteKnowledgeFailure,
  type RemoteKnowledgeFailureCode,
  type RemoteKnowledgeReadPort,
} from "@/ports";

const DEFAULT_LIMIT = 20;
/** The most index rows one read asks for. */
export const REMOTE_INDEX_LIMIT = 500;

/** A remote read that cannot be made at all (no index method on the transport): `unavailable`. */
class RemoteReadUnavailable extends Error implements RemoteKnowledgeFailure {
  readonly code: RemoteKnowledgeFailureCode = "unavailable";
  constructor() {
    super("remote_read_unavailable");
    this.name = "RemoteKnowledgeError";
  }
}

/** The execution error code of a remote failure; undefined when the error is not a remote failure. */
export function remoteFailureToExecutionCode(
  error: unknown
): AiExecutionErrorCode | undefined {
  if (!isRemoteKnowledgeFailure(error)) return undefined;
  switch (error.code) {
    case "access_requested":
      return "remote_access_requested";
    case "policy_denied":
      return "remote_policy_denied";
    case "unavailable":
      return "remote_unavailable";
    case "invalid_id":
      return "invalid_request";
    case "unknown_alias":
      return "internal";
  }
}

/** An `AiExecutionError` carrying the typed code of a remote failure, or the error unchanged otherwise. */
export function toRemoteExecutionError(error: unknown): unknown {
  const code = remoteFailureToExecutionCode(error);
  return code
    ? new AiExecutionError(code, `remote read failed: ${code}`)
    : error;
}

function toIndexRow(raw: unknown): RemoteIndexRow | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.domain !== "string")
    return undefined;
  const entryType = r.entryType ?? r.entry_type ?? r.type;
  const useWhen = r.useWhen ?? r.use_when;
  return {
    id: r.id,
    domain: r.domain,
    entryType: typeof entryType === "string" ? entryType : "",
    useWhen: typeof useWhen === "string" ? useWhen : "",
  };
}

/**
 * The target's governing index rows through the port.
 * TODO(task.5448): `@cogni-dao/ai-tools` 0.16.0 adds `index(alias, { domain?, q?, limit })`. Adopt it
 * (PR1) and confirm its row shape here; until then a transport without `index` fails `unavailable`.
 */
export async function readIndexRows(
  port: RemoteKnowledgeReadPort,
  alias: string
): Promise<readonly GoverningIndexEntry[]> {
  if (!port.index) throw new RemoteReadUnavailable();
  const raw = await port.index(alias, { limit: REMOTE_INDEX_LIMIT });
  return raw
    .map(toIndexRow)
    .filter((row): row is RemoteIndexRow => row !== undefined);
}

/** The stock-tool capability for one remote alias. Reads only. */
export function createRemoteKnowledgeCapability(
  port: RemoteKnowledgeReadPort,
  alias: string
): KnowledgeCapability {
  return {
    async search(params) {
      return port.search(alias, {
        domain: params.domain,
        query: params.query,
        limit: params.limit ?? DEFAULT_LIMIT,
      });
    },
    async list(params) {
      const rows: KnowledgeEntry[] = await port.list(alias, {
        domain: params.domain,
        limit: params.limit ?? DEFAULT_LIMIT,
      });
      const tags = params.tags;
      return tags?.length
        ? rows.filter((row) => tags.every((t) => row.tags?.includes(t)))
        : rows;
    },
    async get(id) {
      return port.get(alias, id);
    },
    async write() {
      throw new Error("knowledge_write_unavailable_for_linked_node");
    },
    async listGoverningIndex() {
      return readIndexRows(port, alias);
    },
  };
}
