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

// Capability factories (shared across all nodes)
export { createKnowledgeCapability } from "./capability.js";
// Domain types & schemas
export {
  assertWritableConfidence,
  BASELINE_CONFIDENCE_BY_SOURCE,
  CONFIDENCE_POLICY_VERSION,
  type ConfidenceCitationBasis,
  type ConfidenceDecision,
  ConfidencePolicyError,
  clampConfidence,
  explainConfidence,
  initializeConfidence,
  recomputeConfidence,
} from "./domain/confidence-policy.js";
// Contribution domain
export {
  type ContributionCitationType,
  ContributionCitationTypeSchema,
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
// Write-pipeline gates (proj.knowledge-syntropy — W0 Gates tier)
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
// Goal codec (tags ⇄ Goal) + KPI reader registry (goal-loop controller seam)
export {
  type DecodedGoalTags,
  decodeGoalTags,
  encodeGoalTags,
  GOAL_CONFIG_TAG_KEYS,
  GOAL_TAG_KEYS,
  type GoalConfigInput,
  type GoalFromRow,
  goalFromRow,
  isGoalTag,
  stepGraphIdFromTags,
  successCriterionFromTags,
} from "./domain/goal-codec.js";
// Goal + KPI loop seam (proj.knowledge-syntropy — goal-loop controller seam)
export {
  applyStep,
  DEFAULT_LOOP_BUDGET,
  type Goal,
  type GoalLoopDecision,
  type GoalLoopHaltDecision,
  type GoalLoopStepDecision,
  GoalSchema,
  goalLoopDecision,
  haltEdge,
  kpiIdFromStrategy,
  type LoopBudget,
  LoopBudgetSchema,
  type LoopHaltReason,
  LoopHaltReasonSchema,
  type LoopState,
  LoopStateSchema,
  loopHaltReason,
  METRIC_STRATEGY_PREFIX,
  type MetricResolutionStrategy,
  MetricResolutionStrategySchema,
} from "./domain/goal-loop.js";
export {
  createConfidenceSmokeReader,
  createExternalCountReader,
  createJudgeReader,
  createKpiReaderRegistry,
  deterministicJudgeScore,
  type ExternalCountReaderConfig,
  type ExternalCountSource,
  JUDGE_KPI_ID,
  type JudgeEvidenceAtom,
  type JudgeEvidenceSource,
  type JudgeInput,
  type JudgeReaderConfig,
  type JudgeScoreFn,
  type OwnConfidenceSource,
} from "./domain/kpi-reader.js";
// Resolver dispatch (pure namespace router: metric: → goal-loop, agent → agent)
export {
  AGENT_STRATEGY,
  classifyResolutionStrategy,
  type ResolverTarget,
} from "./domain/resolver-dispatch.js";
// Domain types & schemas
export {
  type Citation,
  CitationSchema,
  type CitationType,
  CitationTypeSchema,
  type DoltCommit,
  DoltCommitSchema,
  type DoltDiffEntry,
  DoltDiffEntrySchema,
  type EntryType,
  EntryTypeSchema,
  HYPOTHESIS_TARGETED_EDGES,
  isWorkItemEndpointId,
  type Knowledge,
  KnowledgeSchema,
  type NewCitation,
  NewCitationSchema,
  type NewKnowledge,
  NewKnowledgeSchema,
  RAW_WRITE_REJECTS_TYPES,
  type ResolutionStrategy,
  ResolutionStrategySchema,
  type SourceType,
  SourceTypeSchema,
} from "./domain/schemas.js";
export { createEdoCapability } from "./edo-capability.js";
export {
  ContributionConflictError,
  ContributionForbiddenError,
  ContributionNotFoundError,
  ContributionQuotaError,
  ContributionStateError,
  type CreateEdoDecisionInput,
  type CreateEdoHypothesisInput,
  type CreateEdoOutcomeInput,
  type KnowledgeContributionPort,
} from "./port/contribution.port.js";
// EDO resolver port (hypothesis loop)
export type {
  ChainDirection,
  ChainNode,
  EdoResolverPort,
  PendingResolutionsOptions,
  ResolutionEdge,
  ResolutionInput,
  ResolutionResult,
  WalkChainOptions,
} from "./port/edo-resolver.port.js";
// Port interfaces + domain-registry types/errors
export {
  CitationTargetNotFoundError,
  CitationTypeMismatchError,
  type Domain,
  DomainAlreadyRegisteredError,
  DomainNotRegisteredError,
  EdoEntryTypeRequiresAtomicToolError,
  HypothesisMissingEvaluateAtError,
  type KnowledgeStorePort,
  type NewDomain,
} from "./port/knowledge-store.port.js";
// KPI reader port (goal-loop — verifier-independent metric read)
export {
  type KpiReader,
  type KpiReaderRegistry,
  NonIndependentKpiReaderError,
} from "./port/kpi-reader.port.js";
// Contribution service (framework-agnostic, cross-node shared)
export {
  type AppendCommitBody,
  type ContributionService,
  type ContributionServiceDeps,
  type CreateBody,
  type CreateEdoDecisionBody,
  type CreateEdoHypothesisBody,
  type CreateEdoOutcomeBody,
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
