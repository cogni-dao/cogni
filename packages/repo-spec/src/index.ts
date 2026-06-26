// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/repo-spec`
 * Purpose: Pure parsing and typed extraction for .cogni/repo-spec.yaml — governance-managed node configuration.
 * Scope: Zod schemas, parseRepoSpec() function, typed accessor functions. Does not perform I/O, caching, or side effects.
 * Invariants: REPO_SPEC_AUTHORITY — single canonical parser for Node and Operator code. NO_CROSS_IMPORTS — no src/ or services/ imports.
 * Side-effects: none
 * Links: .cogni/repo-spec.yaml, docs/spec/node-operator-contract.md
 * @public
 */

export {
  type DaoConfig,
  extractChainId,
  extractDaoConfig,
  extractDaoTreasuryAddress,
  extractGatesConfig,
  extractGovernanceConfig,
  extractKnowledgeConfig,
  extractLedgerApprovers,
  extractLedgerConfig,
  extractNodeBrandColor,
  extractNodeBrandIcon,
  extractNodeHook,
  extractNodeId,
  extractNodeMission,
  extractNodeName,
  extractNodePath,
  extractNodeSchedules,
  extractNodes,
  extractNodeThumbnail,
  extractOperatorWalletConfig,
  extractOwningNode,
  extractPaymentConfig,
  extractReviewConfig,
  extractScopeId,
  extractStewardWalletConfig,
  type GatesConfig,
  type GovernanceConfig,
  type GovernanceSchedule,
  type InboundPaymentConfig,
  type KnowledgeConfig,
  type LedgerConfig,
  type LedgerPoolConfig,
  type NodeScheduleConfig,
  type OwningNode,
  type ReviewConfig,
  resolveRulePath,
} from "./accessors.js";
export { parseRepoSpec } from "./parse.js";
export { parseRule } from "./rules.js";
export {
  type ActivityLedgerSpec,
  type ActivitySourceSpec,
  activityLedgerSpecSchema,
  activitySourceSpecSchema,
  aiRuleGateSchema,
  type CreditsTopupSpec,
  creditsTopupSpecSchema,
  type GateConfig,
  type GovernanceScheduleSpec,
  type GovernanceSpec,
  gateConfigSchema,
  gatesArraySchema,
  governanceScheduleSchema,
  governanceSpecSchema,
  type KnowledgeRemoteSpec,
  type KnowledgeSpec,
  knowledgeRemoteSpecSchema,
  knowledgeSpecSchema,
  type NodeRegistryEntry,
  type NodeScheduleSpec,
  type NodeSchedules,
  nodeRegistryEntrySchema,
  nodeScheduleSchema,
  nodeSchedulesSchema,
  type OperatorWalletSpec,
  operatorWalletSpecSchema,
  type PoolConfigSpec,
  poolConfigSpecSchema,
  type RepoSpec,
  type ReviewConfig as ReviewConfigSpec,
  type Rule,
  repoSpecSchema,
  reviewConfigSchema,
  reviewLimitsGateSchema,
  ruleSchema,
  type StewardWalletSpec,
  type SuccessCriteria,
  scopeIdSchema,
  scopeKeySchema,
  stewardWalletSpecSchema,
  successCriteriaSchema,
  type ThresholdCriterion,
  thresholdCriterionSchema,
} from "./schema.js";
