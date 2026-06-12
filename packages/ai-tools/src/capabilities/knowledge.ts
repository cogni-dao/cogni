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

/**
 * Confidence score defaults for knowledge entries.
 *
 * - DRAFT (30%): Agent-produced, unverified. Default for all new writes.
 * - VERIFIED (80%): Human-reviewed OR agent-confirmed with fresh sources.
 * - HARDENED (95%): Outcome-validated, statistically significant, or repeatedly confirmed.
 */
export const CONFIDENCE = {
  DRAFT: 30,
  VERIFIED: 80,
  HARDENED: 95,
} as const;

export interface KnowledgeEntry {
  id: string;
  domain: string;
  entityId: string | null;
  title: string;
  content: string;
  confidencePct: number | null;
  sourceType: string;
  sourceRef: string | null;
  tags: string[] | null;
}

export interface KnowledgeSearchParams {
  domain: string;
  query: string;
  limit?: number;
}

export interface KnowledgeListParams {
  domain: string;
  tags?: string[];
  limit?: number;
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

export interface KnowledgeWriteParams {
  id: string;
  domain: string;
  title: string;
  content: string;
  sourceType: "human" | "analysis_signal" | "external" | "derived";
  entityId?: string;
  confidencePct?: number;
  sourceRef?: string;
  tags?: string[];
  /** Outgoing edges (citing = this entry) committed in the same write. */
  citations?: KnowledgeWriteCitation[];
}

/**
 * Knowledge capability — injected into tool implementations at runtime.
 * Backed by KnowledgeStorePort + auto-commit on writes.
 */
export interface KnowledgeCapability {
  /** Search knowledge by domain + text query */
  search(params: KnowledgeSearchParams): Promise<KnowledgeEntry[]>;
  /** List knowledge by domain, optionally filtered by tags */
  list(params: KnowledgeListParams): Promise<KnowledgeEntry[]>;
  /** Get a single knowledge entry by ID */
  get(id: string): Promise<KnowledgeEntry | null>;
  /** Write a knowledge entry + auto-commit. Returns the entry with defaults applied. */
  write(params: KnowledgeWriteParams): Promise<KnowledgeEntry>;
}
