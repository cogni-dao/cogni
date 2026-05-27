// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store`
 * Purpose: Knowledge data plane capability — port, domain types, contribution service, and Zod schemas.
 * Scope: Root barrel exports port interfaces, domain types, and the framework-agnostic contribution service factory. Does not export adapters — those live behind subpath imports.
 * Invariants: PACKAGES_NO_ENV, PACKAGES_NO_LIFECYCLE, PACKAGES_NO_SRC_IMPORTS.
 * Side-effects: none
 * Links: docs/spec/knowledge-data-plane.md, docs/design/knowledge-contribution-api.md
 * @public
 */

// Capability factory (shared across all nodes)
export { createKnowledgeCapability } from "./capability.js";
// Contribution domain
export {
  type ContributionCommitRecord,
  ContributionCommitRecordSchema,
  type ContributionDiffEntry,
  ContributionDiffEntrySchema,
  type ContributionRecord,
  ContributionRecordSchema,
  type ContributionState,
  ContributionStateSchema,
  type KnowledgeContributionEdit,
  KnowledgeContributionEditSchema,
  type KnowledgeEntryInput,
  KnowledgeEntryInputSchema,
  type Principal,
  type PrincipalKind,
  PrincipalKindSchema,
  PrincipalSchema,
} from "./domain/contribution-schemas.js";
// Write-pipeline gates (proj.knowledge-write-pipeline)
export {
  type GateContext,
  type GateError,
  type GateResult,
  type KnowledgeGate,
  KnowledgeGateError,
  type KnowledgeWriteCandidate,
  provenanceGate,
  runGateChain,
  shapeGate,
  V0_DETERMINISTIC_GATES,
} from "./domain/gates/index.js";
// Domain types & schemas
export {
  type DoltCommit,
  DoltCommitSchema,
  type DoltDiffEntry,
  DoltDiffEntrySchema,
  type EntryType,
  EntryTypeSchema,
  type Knowledge,
  KnowledgeSchema,
  type NewKnowledge,
  NewKnowledgeSchema,
  type SourceType,
  SourceTypeSchema,
} from "./domain/schemas.js";
export {
  ContributionConflictError,
  ContributionForbiddenError,
  ContributionNotFoundError,
  ContributionQuotaError,
  ContributionStateError,
  type KnowledgeContributionPort,
} from "./port/contribution.port.js";
// Port interfaces + domain-registry types/errors
export {
  type Domain,
  DomainAlreadyRegisteredError,
  DomainNotRegisteredError,
  type KnowledgeStorePort,
  type NewDomain,
} from "./port/knowledge-store.port.js";
// Contribution service (framework-agnostic, cross-node shared)
export {
  type AppendCommitBody,
  type ContributionService,
  type ContributionServiceDeps,
  type CreateBody,
  createContributionService,
  defaultCanMergeKnowledge,
  type ListQuery,
} from "./service/contribution-service.js";
// Auth helpers
export {
  type PrincipalAuthSource,
  type SessionUserLike,
  sessionUserToPrincipal,
} from "./util/session-to-principal.js";
