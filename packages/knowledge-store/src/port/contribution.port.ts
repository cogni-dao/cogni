// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/port/contribution.port`
 * Purpose: Port interface for external-agent knowledge contributions backed by Dolt branches.
 * Scope: Interface + typed error classes. Does not contain implementation, I/O, or framework dependencies.
 * Invariants: EXTERNAL_CONTRIB_VIA_BRANCH, EDO_BEARER_VIA_CONTRIB_BRANCH, KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION.
 *   Appending/closing is allowed for the contribution owner; merge requires an admin session.
 *   Bearer-authenticated EDO writes (hypothesis/decision/outcome) MUST open a
 *   contrib branch — the dedicated `createEdo*` methods apply the multi-row
 *   atomic batch on that branch with one Dolt commit per batch.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md, docs/spec/knowledge-syntropy.md
 * @public
 */

import type {
  ContributionCommitRecord,
  ContributionDiffEntry,
  ContributionRecord,
  ContributionState,
  KnowledgeContributionEdit,
  Principal,
} from "../domain/contribution-schemas.js";

/**
 * Inputs for a hypothesis atomic batch (hypothesis row + N evidence_for
 * citations + commit), applied on a fresh contrib branch.
 * Mirrors `HypothesizeParams` minus principal-derived source fields, which
 * the adapter stamps from the contribution context.
 */
export interface CreateEdoHypothesisInput {
  principal: Principal;
  message: string;
  idempotencyKey?: string;
  entry: {
    id: string;
    domain: string;
    title: string;
    content: string;
    evaluateAt: Date;
    resolutionStrategy?: string | null;
    tags?: string[];
    confidencePct?: number;
  };
  evidenceForIds?: string[];
}

/**
 * Inputs for a decision atomic batch (decision row + 1 derives_from citation
 * + commit), applied on a fresh contrib branch.
 */
export interface CreateEdoDecisionInput {
  principal: Principal;
  message: string;
  idempotencyKey?: string;
  entry: {
    id: string;
    domain: string;
    title: string;
    content: string;
    tags?: string[];
    confidencePct?: number;
  };
  derivesFromHypothesisId: string;
}

/**
 * Inputs for an outcome atomic batch (outcome row + 1 validates/invalidates
 * citation + hypothesis confidence recompute + commit), applied on a fresh
 * contrib branch.
 */
export interface CreateEdoOutcomeInput {
  principal: Principal;
  message: string;
  idempotencyKey?: string;
  entry: {
    id: string;
    domain: string;
    title: string;
    content: string;
    tags?: string[];
    confidencePct?: number;
  };
  hypothesisId: string;
  edge: "validates" | "invalidates";
}

export interface KnowledgeContributionPort {
  create(input: {
    principal: Principal;
    message: string;
    edits?: KnowledgeContributionEdit[];
    idempotencyKey?: string;
  }): Promise<ContributionRecord>;

  appendCommit(input: {
    contributionId: string;
    principal: Principal;
    message: string;
    edits: KnowledgeContributionEdit[];
  }): Promise<ContributionCommitRecord>;

  /**
   * Open a contrib branch and apply a hypothesis + N evidence_for citations
   * + single Dolt commit on that branch. Enforces the same adapter-layer
   * invariants as `EdoCapability.hypothesize` (HYPOTHESIS_HAS_EVALUATE_AT,
   * CITATION_TARGET_EXISTS_AT_WRITE, EDGE_TYPE_MATCHES_CITED_ENTRY_TYPE).
   * Returns the open `ContributionRecord`; main is unmodified until merge.
   */
  createEdoHypothesis(
    input: CreateEdoHypothesisInput
  ): Promise<ContributionRecord>;

  /**
   * Open a contrib branch and apply a decision + derives_from citation +
   * single Dolt commit on that branch. The citation target (hypothesisId)
   * must already exist on `main` (the branch base) — cross-branch lookups
   * are not yet supported.
   */
  createEdoDecision(input: CreateEdoDecisionInput): Promise<ContributionRecord>;

  /**
   * Open a contrib branch and apply an outcome + validates/invalidates
   * citation + hypothesis confidence recompute + single Dolt commit on that
   * branch. The cited hypothesis must already exist on `main`. Confidence
   * recompute is performed inside the branch so the reviewer sees the new
   * value pre-merge.
   */
  createEdoOutcome(input: CreateEdoOutcomeInput): Promise<ContributionRecord>;

  /**
   * COMPOUNDING_VIA_ONE_OPEN_CONTRIBUTION_PER_PRINCIPAL.
   * Returns the principal's single open contribution, or null. Used by the
   * service to decide append-to-existing vs open-new on EDO writes. The
   * invariant: one bearer principal has at most one open contribution at a
   * time, so a hypothesize -> decide -> record-outcome chain by the same
   * agent compounds onto one branch (one human merge gates the whole loop)
   * instead of sprawling into N parallel branches.
   */
  findOpenForPrincipal(
    principalId: string
  ): Promise<ContributionRecord | null>;

  /**
   * Append a hypothesis + N evidence_for citations + single Dolt commit to
   * an existing open contribution's branch. Same invariants as
   * createEdoHypothesis. Bumps commitCount + headCommit; the reviewer sees
   * the whole chain on one branch.
   */
  appendEdoHypothesis(
    input: CreateEdoHypothesisInput & { contributionId: string }
  ): Promise<ContributionRecord>;

  appendEdoDecision(
    input: CreateEdoDecisionInput & { contributionId: string }
  ): Promise<ContributionRecord>;

  appendEdoOutcome(
    input: CreateEdoOutcomeInput & { contributionId: string }
  ): Promise<ContributionRecord>;

  list(query: {
    state: ContributionState | "all";
    principalId?: string;
    limit: number;
  }): Promise<ContributionRecord[]>;

  getById(contributionId: string): Promise<ContributionRecord | null>;

  listCommits(contributionId: string): Promise<ContributionCommitRecord[]>;

  diff(contributionId: string): Promise<ContributionDiffEntry[]>;

  merge(input: {
    contributionId: string;
    principal: Principal;
    confidencePct?: number;
  }): Promise<{ commitHash: string }>;

  close(input: {
    contributionId: string;
    principal: Principal;
    reason: string;
  }): Promise<void>;
}

export class ContributionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContributionConflictError";
  }
}

export class ContributionNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContributionNotFoundError";
  }
}

export class ContributionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContributionStateError";
  }
}

export class ContributionQuotaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContributionQuotaError";
  }
}

export class ContributionForbiddenError extends Error {
  constructor(message: string = "forbidden") {
    super(message);
    this.name = "ContributionForbiddenError";
  }
}
