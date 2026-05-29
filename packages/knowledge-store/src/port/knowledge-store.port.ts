// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/port`
 * Purpose: KnowledgeStorePort — typed capability for versioned domain knowledge.
 * Scope: Port interface + domain-registry types + typed errors. Does not contain implementations, I/O, or framework dependencies.
 * Invariants:
 *   - PORT_BEFORE_BACKEND: All knowledge access goes through this port.
 *   - PACKAGES_NO_ENV, PACKAGES_NO_LIFECYCLE.
 *   - DOMAIN_FK_ENFORCED_AT_WRITE: every write to knowledge verifies `domain` exists.
 *   - CITATION_TARGET_EXISTS_AT_WRITE: every addCitation verifies cited_id exists.
 *   - EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE: addCitation checks cited row's entry_type.
 *   - HYPOTHESIS_HAS_EVALUATE_AT: addKnowledge rejects hypothesis rows w/o evaluate_at.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/spec/knowledge-domain-registry.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import type {
  Citation,
  CitationType,
  DoltCommit,
  DoltDiffEntry,
  Knowledge,
  NewCitation,
  NewKnowledge,
} from "../domain/schemas.js";

// ---------------------------------------------------------------------------
// Domain registry types
// ---------------------------------------------------------------------------

export interface Domain {
  id: string;
  name: string;
  description: string | null;
  confidencePct: number;
  entryCount: number;
  createdAt: string; // ISO timestamp
}

export interface NewDomain {
  id: string;
  name: string;
  description?: string;
}

export class DomainNotRegisteredError extends Error {
  readonly domain: string;
  constructor(domain: string) {
    super(`domain '${domain}' not registered`);
    this.name = "DomainNotRegisteredError";
    this.domain = domain;
  }
}

export class DomainAlreadyRegisteredError extends Error {
  readonly domain: string;
  constructor(domain: string) {
    super(`domain '${domain}' already registered`);
    this.name = "DomainAlreadyRegisteredError";
    this.domain = domain;
  }
}

// ---------------------------------------------------------------------------
// Hypothesis-loop typed errors (knowledge-syntropy.md § Enforcement Points)
// ---------------------------------------------------------------------------

/**
 * Thrown by `addKnowledge` / `upsertKnowledge` when a hypothesis row is
 * written without `evaluate_at`. Enforces `HYPOTHESIS_HAS_EVALUATE_AT`.
 */
export class HypothesisMissingEvaluateAtError extends Error {
  readonly entryId: string;
  constructor(entryId: string) {
    super(
      `hypothesis '${entryId}' is missing evaluate_at — hypothesis rows must declare a resolution date`
    );
    this.name = "HypothesisMissingEvaluateAtError";
    this.entryId = entryId;
  }
}

/**
 * Thrown by `addCitation` when the cited row does not exist.
 * Enforces `CITATION_TARGET_EXISTS_AT_WRITE`.
 */
export class CitationTargetNotFoundError extends Error {
  readonly citedId: string;
  constructor(citedId: string) {
    super(`citation target '${citedId}' not found in knowledge`);
    this.name = "CitationTargetNotFoundError";
    this.citedId = citedId;
  }
}

/**
 * Thrown by `addCitation` when the cited row's `entry_type` does not match
 * the citation_type's contract. `derives_from`/`validates`/`invalidates`
 * require `cited.entry_type === 'hypothesis'`. Enforces
 * `EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE`.
 */
export class CitationTypeMismatchError extends Error {
  readonly citationType: CitationType;
  readonly citedId: string;
  readonly citedEntryType: string;
  readonly expectedEntryType: string;
  constructor(
    citationType: CitationType,
    citedId: string,
    citedEntryType: string,
    expectedEntryType: string
  ) {
    super(
      `citation_type '${citationType}' requires cited entry_type='${expectedEntryType}', but '${citedId}' has entry_type='${citedEntryType}'`
    );
    this.name = "CitationTypeMismatchError";
    this.citationType = citationType;
    this.citedId = citedId;
    this.citedEntryType = citedEntryType;
    this.expectedEntryType = expectedEntryType;
  }
}

/**
 * Thrown by `core__knowledge_write` when an EDO entry_type
 * (`hypothesis`/`decision`/`outcome`) bypasses the atomic tool.
 * Enforces `RAW_WRITE_REJECTS_TYPES`.
 */
export class EdoEntryTypeRequiresAtomicToolError extends Error {
  readonly entryType: string;
  constructor(entryType: string) {
    super(
      `entry_type '${entryType}' must be written via the atomic core__edo_* tool, not core__knowledge_write`
    );
    this.name = "EdoEntryTypeRequiresAtomicToolError";
    this.entryType = entryType;
  }
}

// ---------------------------------------------------------------------------
// Port interface
// ---------------------------------------------------------------------------

export interface KnowledgeStorePort {
  // --- Read ---
  getKnowledge(id: string): Promise<Knowledge | null>;
  listKnowledge(
    domain: string,
    opts?: { tags?: string[]; limit?: number }
  ): Promise<Knowledge[]>;
  searchKnowledge(
    domain: string,
    query: string,
    opts?: { limit?: number }
  ): Promise<Knowledge[]>;
  /** List distinct domain values present in the `knowledge` table (legacy / back-compat). */
  listDomains(): Promise<string[]>;

  // --- Domain registry (DOMAIN_FK_ENFORCED_AT_WRITE) ---
  /** Returns true iff `id` is a row in the `domains` table. */
  domainExists(id: string): Promise<boolean>;
  /** Full `domains` rows + `entry_count` (LEFT JOIN knowledge, single query). */
  listDomainsFull(): Promise<Domain[]>;
  /**
   * Insert a new row in `domains` and auto-commit. Throws
   * `DomainAlreadyRegisteredError` on duplicate id.
   */
  registerDomain(input: NewDomain): Promise<Domain>;

  // --- Write — rows ---
  /** Upsert: inserts new entry or updates existing entry with same ID. */
  upsertKnowledge(entry: NewKnowledge): Promise<Knowledge>;
  addKnowledge(entry: NewKnowledge): Promise<Knowledge>;
  updateKnowledge(
    id: string,
    update: Partial<NewKnowledge>
  ): Promise<Knowledge>;
  /** Admin/cleanup only; agents use DEPRECATE_NOT_DELETE. */
  deleteKnowledge(id: string): Promise<void>;

  // --- Read — knowledge identity (knowledge-syntropy: CITATION_TARGET_EXISTS_AT_WRITE) ---
  /**
   * Returns `entry_type` if a row with `id` exists in `knowledge`, otherwise
   * null. Single SELECT — collapses the existence check + entry_type fetch
   * that `addCitation` needs into one roundtrip.
   */
  getKnowledgeEntryType(id: string): Promise<string | null>;
  /** Returns true iff `id` is a row in `knowledge`. Convenience wrapper. */
  knowledgeExists(id: string): Promise<boolean>;

  // --- Write — edges (knowledge-syntropy: CITATION_TARGET_EXISTS_AT_WRITE + EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE) ---
  /**
   * Insert a row in `citations`. Adapter MUST verify the cited row exists
   * (CITATION_TARGET_EXISTS_AT_WRITE) and its entry_type matches the
   * citation_type contract (EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE).
   * Throws `CitationTargetNotFoundError` or `CitationTypeMismatchError`.
   * Idempotent on the unique (citing_id, cited_id, citation_type) index —
   * duplicate inserts return the existing row, not an error.
   */
  addCitation(edge: NewCitation): Promise<Citation>;

  /** List edges where citing_id = id (outgoing). */
  listCitationsByCitingId(citingId: string): Promise<Citation[]>;
  /** List edges where cited_id = id (incoming). Used by recomputeConfidence. */
  listCitationsByCitedId(citedId: string): Promise<Citation[]>;

  // --- Doltgres versioning ---
  commit(message: string): Promise<string>;
  log(limit?: number): Promise<DoltCommit[]>;
  diff(fromRef: string, toRef: string): Promise<DoltDiffEntry[]>;
  currentCommit(): Promise<string>;
}
