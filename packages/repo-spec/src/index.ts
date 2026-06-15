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
  extractNodeId,
  extractNodePath,
  extractNodes,
  extractOperatorWalletConfig,
  extractOwningNode,
  extractPaymentConfig,
  extractScopeId,
  type GatesConfig,
  type GovernanceConfig,
  type GovernanceSchedule,
  type InboundPaymentConfig,
  type KnowledgeConfig,
  type LedgerConfig,
  type LedgerPoolConfig,
  type OwningNode,
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
  nodeRegistryEntrySchema,
  type OperatorWalletSpec,
  operatorWalletSpecSchema,
  type PoolConfigSpec,
  poolConfigSpecSchema,
  type RepoSpec,
  type Rule,
  repoSpecSchema,
  reviewLimitsGateSchema,
  ruleSchema,
  type SuccessCriteria,
  scopeIdSchema,
  scopeKeySchema,
  successCriteriaSchema,
  type ThresholdCriterion,
  thresholdCriterionSchema,
} from "./schema.js";
