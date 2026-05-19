// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/port/contribution.port`
 * Purpose: Port interface for external-agent knowledge contributions backed by Dolt branches.
 * Scope: Interface + typed error classes. Does not contain implementation, I/O, or framework dependencies.
 * Invariants: EXTERNAL_CONTRIB_VIA_BRANCH, KNOWLEDGE_MERGE_REQUIRES_ADMIN_SESSION.
 *   Appending/closing is allowed for the contribution owner; merge requires an admin session.
 * Side-effects: none
 * Links: docs/design/knowledge-contribution-api.md
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
