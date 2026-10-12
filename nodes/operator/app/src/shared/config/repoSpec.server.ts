// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/config/repoSpec.server`
 * Purpose: Server-only thin wrapper — file I/O, caching, and accessor functions for repo-spec config including DAO governance and VCS identity.
 * Scope: Reads and caches repo-spec on first access; does not define schemas, validation logic, or perform network I/O.
 * Invariants: Chain ID must match CHAIN_ID; ledger config requires scope_id + scope_key; DaoConfig requires the four on-chain governance identity fields (base_url optional).
 *   getGithubRepo() is a v0 single-tenant hardcode (OPERATOR_GITHUB_REPO const) — task.0122 wires it to NodeRegistryPort for multi-tenant.
 * Side-effects: IO (reads repo-spec from disk) on first call only. getGithubRepo() has no IO.
 * Links: packages/repo-spec/src/index.ts, .cogni/repo-spec.yaml, docs/spec/vcs-integration.md
 * @public
 */

import fs from "node:fs";
import path from "node:path";
import { CHAIN_ID } from "@cogni/node-shared";
import {
  type DaoConfig,
  extractChainId,
  extractDaoConfig,
  extractDaoTokenDistributionConfig,
  extractDaoTreasuryAddress,
  extractDistributorAddress,
  extractGovernanceConfig,
  extractKnowledgeConfig,
  extractLedgerApprovers,
  extractLedgerConfig,
  extractNodeBrandColor,
  extractNodeBrandIcon,
  extractNodeHook,
  extractNodeMission,
  extractNodeName,
  extractNodeSchedules,
  extractNodeThumbnail,
  extractOperatorWalletConfig,
  extractPaymentConfig,
  extractStewardWalletConfig,
  type GovernanceConfig,
  type InboundPaymentConfig,
  type KnowledgeConfig,
  type NodeScheduleConfig,
  type OperatorWalletSpec,
  parseRepoSpec,
  type RepoSpec,
  type StewardWalletSpec,
} from "@cogni/repo-spec";
import { serverEnv } from "@/shared/env";

export type {
  DaoConfig,
  GovernanceConfig,
  GovernanceSchedule,
  InboundPaymentConfig,
  KnowledgeConfig,
  LedgerConfig,
  LedgerPoolConfig,
  NodeScheduleConfig,
} from "@cogni/repo-spec";

// ---------------------------------------------------------------------------
// File I/O + caching (server-only concerns)
// ---------------------------------------------------------------------------

let cachedSpec: RepoSpec | null = null;

function loadRepoSpec(): RepoSpec {
  if (cachedSpec) return cachedSpec;

  const repoRoot = serverEnv().COGNI_REPO_ROOT;
  if (!repoRoot) {
    throw new Error(
      "[repo-spec] COGNI_REPO_PATH not configured — repo-spec unavailable"
    );
  }
  const repoSpecPath = path.join(repoRoot, ".cogni", "repo-spec.yaml");

  if (!fs.existsSync(repoSpecPath)) {
    throw new Error(
      `[repo-spec] Missing configuration at ${repoSpecPath}; DAO wallet and chain settings must be committed`
    );
  }

  const content = fs.readFileSync(repoSpecPath, "utf8");
  cachedSpec = parseRepoSpec(content);
  return cachedSpec;
}

// ---------------------------------------------------------------------------
// Cached accessors (delegate to @cogni/repo-spec pure functions)
// ---------------------------------------------------------------------------

let cachedPaymentConfig: InboundPaymentConfig | undefined | null = null;

export function getPaymentConfig(): InboundPaymentConfig | undefined {
  if (cachedPaymentConfig !== null) return cachedPaymentConfig;

  const spec = loadRepoSpec();
  cachedPaymentConfig = extractPaymentConfig(spec, CHAIN_ID);
  return cachedPaymentConfig;
}

let cachedNodeId: string | null = null;

/**
 * Node identity from repo-spec. Scopes all ledger tables.
 * Fails fast if repo-spec is missing or node_id is invalid.
 */
export function getNodeId(): string {
  if (cachedNodeId) return cachedNodeId;

  const spec = loadRepoSpec();
  cachedNodeId = spec.node_id;
  return cachedNodeId;
}

let cachedNodeName: string | null = null;

/** Human-facing node slug from repo-spec `intent.name` (falls back to node_id). */
export function getNodeName(): string {
  if (cachedNodeName) return cachedNodeName;
  cachedNodeName = extractNodeName(loadRepoSpec());
  return cachedNodeName;
}

/** One-line node mission from repo-spec `intent.mission`, or null when undeclared. */
export function getNodeMission(): string | null {
  return extractNodeMission(loadRepoSpec());
}

/** Punchy ~5-word gallery/heading hook from repo-spec `intent.hook`, or null. */
export function getNodeHook(): string | null {
  return extractNodeHook(loadRepoSpec());
}

/** Self-hosted brand thumbnail URL from repo-spec `intent.brand.thumbnail`, or null. */
export function getNodeThumbnail(): string | null {
  return extractNodeThumbnail(loadRepoSpec());
}

/** Monogram-tint brand color from repo-spec `intent.brand.color`, or null. */
export function getNodeBrandColor(): string | null {
  return extractNodeBrandColor(loadRepoSpec());
}

/** Lucide icon NAME (PascalCase) for the node's brand mark from repo-spec `intent.brand.icon`, or null. */
export function getNodeBrandIcon(): string | null {
  return extractNodeBrandIcon(loadRepoSpec());
}

let cachedScopeId: string | null = null;

/**
 * Scope identity from repo-spec. Used by DrizzleAttributionAdapter for SCOPE_GATED_QUERIES.
 * Fails fast if repo-spec is missing scope_id.
 */
export function getScopeId(): string {
  if (cachedScopeId) return cachedScopeId;

  const spec = loadRepoSpec();
  if (!spec.scope_id) {
    throw new Error(
      "repo-spec missing scope_id — required for ledger scope gating"
    );
  }
  cachedScopeId = spec.scope_id;
  return cachedScopeId;
}

let cachedGovernanceConfig: GovernanceConfig | null = null;

export function getGovernanceConfig(): GovernanceConfig {
  if (cachedGovernanceConfig) return cachedGovernanceConfig;

  const spec = loadRepoSpec();
  cachedGovernanceConfig = extractGovernanceConfig(spec);
  return cachedGovernanceConfig;
}

let cachedNodeSchedules: readonly NodeScheduleConfig[] | null = null;

/** Node-owned recurring-work declarations from this node's repo-spec. */
export function getNodeSchedules(): readonly NodeScheduleConfig[] {
  if (cachedNodeSchedules) return cachedNodeSchedules;
  cachedNodeSchedules = extractNodeSchedules(loadRepoSpec());
  return cachedNodeSchedules;
}

// ---------------------------------------------------------------------------
// DAO config — governance section (for governance signal execution + review deep links)
// ---------------------------------------------------------------------------

let cachedDaoConfig: DaoConfig | null | undefined;

/**
 * DAO governance configuration from repo-spec.
 * Returns null only when the on-chain identity (dao/plugin/signal contracts +
 * chain_id) is incomplete. `base_url` is the optional governance-UI deep-link
 * host and does not gate this read.
 */
export function getDaoConfig(): DaoConfig | null {
  if (cachedDaoConfig !== undefined) return cachedDaoConfig;

  const spec = loadRepoSpec();
  cachedDaoConfig = extractDaoConfig(spec);
  return cachedDaoConfig;
}

/**
 * The node's own on-chain tokenomics identity, sourced from repo-spec — NOT from any
 * distribution manifest. Token supply and the distributor exist the moment the DAO is
 * formed + a distributor is deployed, INDEPENDENT of whether any epoch has been
 * finalized. This is what the Ownership page reads so tokenomics render on a freshly
 * seeded node (zero epochs) exactly as they do after distributions.
 */
export interface NodeTokenomicsConfig {
  /** Governance ERC20 token (governance.token_contract); null until on-chain. */
  readonly tokenAddress: string | null;
  /** Cumulative Merkle distributor (distributions.distributor_address); null until deployed. */
  readonly distributorAddress: string | null;
  /** EVM chain id (governance.chain_id). */
  readonly chainId: number;
  /** `distributions.status: active` in the node's own repo-spec (setup step-1 complete). */
  readonly distributionsActive: boolean;
}

let cachedNodeTokenomicsConfig: NodeTokenomicsConfig | null = null;

/**
 * The node's token / distributor / chain from repo-spec (governance.token_contract,
 * distributions.distributor_address, governance.chain_id). Manifest-independent.
 */
export function getNodeTokenomicsConfig(): NodeTokenomicsConfig {
  if (cachedNodeTokenomicsConfig) return cachedNodeTokenomicsConfig;

  const spec = loadRepoSpec();
  cachedNodeTokenomicsConfig = {
    tokenAddress: spec.governance?.token_contract ?? null,
    distributorAddress: extractDistributorAddress(spec) ?? null,
    chainId: extractChainId(spec),
    distributionsActive: spec.distributions?.status === "active",
  };
  return cachedNodeTokenomicsConfig;
}

let cachedEmissionsHolder: string | null | undefined;

/**
 * DAO that mints + owns the distributor (governance.emissions_holder), from the node's
 * OWN repo-spec. Null until distributions are activated. Feeds the finalize fold's
 * bug.5020 execute-guard on the baked-fallback path (mirrors the worker container's
 * `emissionsHolderAddress`).
 */
export function getEmissionsHolderAddress(): string | null {
  if (cachedEmissionsHolder !== undefined) return cachedEmissionsHolder;
  const spec = loadRepoSpec();
  cachedEmissionsHolder =
    extractDaoTokenDistributionConfig(spec)?.emissionsHolderAddress ?? null;
  return cachedEmissionsHolder;
}

let cachedLedgerSelectionConfig: {
  readonly excludedLogins: string[];
  readonly sourceRefs: string[];
} | null = null;

/**
 * Selection-time config for the attribution registries — excluded logins + the
 * per-source repo allowlist, aggregated across all `activity_sources`. Empty when no
 * ledger config (fail-open: no filtering). Mirrors the worker container's
 * `excludedLogins`/`sourceRefs` derivation so in-process finalize builds identical
 * registries.
 */
export function getLedgerSelectionConfig(): {
  readonly excludedLogins: string[];
  readonly sourceRefs: string[];
} {
  if (cachedLedgerSelectionConfig) return cachedLedgerSelectionConfig;
  const spec = loadRepoSpec();
  const ledgerConfig = extractLedgerConfig(spec);
  cachedLedgerSelectionConfig = {
    excludedLogins: ledgerConfig
      ? Object.values(ledgerConfig.activitySources).flatMap(
          (s) => s.excludedLogins ?? []
        )
      : [],
    sourceRefs: ledgerConfig
      ? Object.values(ledgerConfig.activitySources).flatMap(
          (s) => s.sourceRefs ?? []
        )
      : [],
  };
  return cachedLedgerSelectionConfig;
}

let cachedLedgerApprovers: string[] | null = null;

/**
 * Ledger approver allowlist from repo-spec.
 * Returns lowercased EVM addresses for case-insensitive comparison.
 * Returns empty array if ledger config not present (write routes will reject all).
 */
export function getLedgerApprovers(): string[] {
  if (cachedLedgerApprovers) return cachedLedgerApprovers;

  const spec = loadRepoSpec();
  cachedLedgerApprovers = extractLedgerApprovers(spec);
  return cachedLedgerApprovers;
}

/**
 * True when the wallet is a repo-spec ledger approver (activity_ledger.approvers).
 * Mirrors node-template's gate. Empty allowlist → always false.
 */
export function isLedgerApprover(wallet: string | null | undefined): boolean {
  if (!wallet) return false;
  return getLedgerApprovers().includes(wallet.toLowerCase());
}

/**
 * DAO-admin gate for the `(admin)` route group. A wallet is an admin when it is a
 * ledger approver OR the configured steward wallet (payments_out.steward_wallet).
 *
 * The steward-wallet clause lets the operator node gate its admin tab on the
 * governance approver/admin wallet WITHOUT requiring a full `activity_ledger` block
 * in its runtime repo-spec (which would synthesize a LEDGER_INGEST schedule as a
 * side effect). At MVP steward == approver == admin (the same wallet).
 */
export function isDaoAdmin(wallet: string | null | undefined): boolean {
  if (!wallet) return false;
  if (isLedgerApprover(wallet)) return true;
  const steward = getStewardWalletConfig();
  return !!steward && steward.address.toLowerCase() === wallet.toLowerCase();
}

let cachedOperatorWalletConfig: OperatorWalletSpec | undefined | null = null;

/**
 * Operator wallet configuration from repo-spec.
 * Returns undefined if operator_wallet section is not present.
 */
export function getOperatorWalletConfig(): OperatorWalletSpec | undefined {
  if (cachedOperatorWalletConfig !== null) return cachedOperatorWalletConfig;

  const spec = loadRepoSpec();
  cachedOperatorWalletConfig = extractOperatorWalletConfig(spec);
  return cachedOperatorWalletConfig;
}

let cachedDaoTreasuryAddress: string | undefined | null = null;

/**
 * DAO treasury address from repo-spec (governance.dao_contract).
 * Returns undefined if not present.
 */
export function getDaoTreasuryAddress(): string | undefined {
  if (cachedDaoTreasuryAddress !== null) return cachedDaoTreasuryAddress;

  const spec = loadRepoSpec();
  cachedDaoTreasuryAddress = extractDaoTreasuryAddress(spec);
  return cachedDaoTreasuryAddress;
}

let cachedStewardWalletConfig: StewardWalletSpec | undefined | null = null;

/**
 * Steward wallet configuration from repo-spec (payments_out.steward_wallet).
 * The human-custodied address the operator wallet funds via withdrawToSteward.
 * Returns undefined if payments_out is not present.
 */
export function getStewardWalletConfig(): StewardWalletSpec | undefined {
  if (cachedStewardWalletConfig !== null) return cachedStewardWalletConfig;

  const spec = loadRepoSpec();
  cachedStewardWalletConfig = extractStewardWalletConfig(spec);
  return cachedStewardWalletConfig;
}

let cachedKnowledgeConfig: KnowledgeConfig | undefined | null = null;

/**
 * Node-local knowledge plane config from repo-spec.
 * Returns undefined for pre-knowledge nodes.
 */
export function getKnowledgeConfig(): KnowledgeConfig | undefined {
  if (cachedKnowledgeConfig !== null) return cachedKnowledgeConfig;

  const spec = loadRepoSpec();
  cachedKnowledgeConfig = extractKnowledgeConfig(spec);
  return cachedKnowledgeConfig;
}

// v0: operator manages exactly one repo — its own.
// task.0122 (operator node registration lifecycle) wires this to the NodeRegistryPort
// so the operator can dispatch flights for any registered node repo without cross-pollination
// between app credentials and repo identity. Until then, single-tenant hardcode here only.
const OPERATOR_GITHUB_REPO = {
  owner: "cogni-dao",
  repo: "cogni",
} as const;

/**
 * GitHub repo identity for VCS operations.
 * v0: single-tenant hardcode — operator manages its own repo only.
 * vNext: resolved from NodeRegistryPort per request context (task.0122).
 */
export function getGithubRepo(): { owner: string; repo: string } {
  return OPERATOR_GITHUB_REPO;
}
