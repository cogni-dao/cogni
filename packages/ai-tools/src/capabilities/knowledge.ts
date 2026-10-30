// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/knowledge`
 * Purpose: Capability interface for knowledge store access. Tools receive this, not raw DB connections.
 * Scope: Interface + confidence defaults only. Does not contain I/O or implementations.
 * Invariants:
 *   - AUTH_VIA_CAPABILITY_INTERFACE: Tools receive knowledge access via this capability, not DSNs.
 *   - CONFIDENCE_DEFAULTS: draft=30, verified=80, hardened=95.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md
 * @public
 */

import type {
  KnowledgeRow as KnowledgeEntry,
  KnowledgeCapability as SharedKnowledgeCapability,
  KnowledgeListParams as SharedKnowledgeListParams,
  KnowledgeSearchParams as SharedKnowledgeSearchParams,
  KnowledgeWriteParams as SharedKnowledgeWriteParams,
} from "@cogni/shared-knowledge-store/contracts";

export {
  type ActiveGoalInfo,
  CONFIDENCE,
  type KnowledgeRow as KnowledgeEntry,
} from "@cogni/shared-knowledge-store/contracts";

export interface KnowledgeSearchParams extends SharedKnowledgeSearchParams {
  /** Operator browse callers may opt in to EDO machinery. */
  includeEdo?: boolean;
}
export interface KnowledgeListParams extends SharedKnowledgeListParams {
  includeEdo?: boolean;
}

/**
 * Outgoing edge written alongside a new entry. Restricted to the non-temporal
 * knowledge edges — the hypothesis-loop edges (`evidence_for`/`derives_from`/
 * `validates`/`invalidates`) are written through the `core__edo_*` tools, not
 * here. Lets an agent compound knowledge in one write (e.g. a synthesis that
 * `supports` the findings it summarizes).
 */
export interface KnowledgeWriteCitation {
  citedId: string;
  citationType: "supports" | "contradicts" | "extends" | "supersedes";
  context?: string;
}

export interface KnowledgeWriteParams extends SharedKnowledgeWriteParams {
  /** Outgoing edges (citing = this entry) committed in the same write. */
  citations?: KnowledgeWriteCitation[];
}

/**
 * Knowledge capability — injected into tool implementations at runtime.
 * Backed by KnowledgeStorePort + auto-commit on writes.
 */
export interface KnowledgeCapability extends SharedKnowledgeCapability {
  search(params: KnowledgeSearchParams): Promise<KnowledgeEntry[]>;
  list(params: KnowledgeListParams): Promise<KnowledgeEntry[]>;
  write(params: KnowledgeWriteParams): Promise<KnowledgeEntry>;
  /**
   * The hub's governing guidance index (guidance-routing-design): every governing row across all
   * domains with its use-when trigger, sorted by domain then id. Optional: a node whose store has no
   * index reader omits it and `core__knowledge_index` reports the index unavailable.
   */
  listGoverningIndex?(): Promise<readonly GoverningIndexEntry[]>;
}

/** One governing index row as tools see it: routing metadata, never a body. */
export interface GoverningIndexEntry {
  readonly id: string;
  readonly domain: string;
  readonly entryType: string;
  readonly useWhen: string;
}
