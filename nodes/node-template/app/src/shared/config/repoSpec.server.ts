// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/config/repoSpec.server`
 * Purpose: Server-only thin wrapper — file I/O, caching, and CHAIN_ID validation for repo-spec accessors including DAO governance config.
 * Scope: Reads and caches repo-spec on first access; does not define schemas, validation logic, or perform network I/O.
 * Invariants: Chain ID must match CHAIN_ID; ledger config requires scope_id + scope_key; DaoConfig requires all five cogni_dao fields.
 * Side-effects: IO (reads repo-spec from disk) on first call only.
 * Links: packages/repo-spec/src/index.ts, .cogni/repo-spec.yaml
 * @public
 */

import fs from "node:fs";
import path from "node:path";
import { CHAIN_ID } from "@cogni/node-shared";
import {
  type DaoConfig,
  extractDaoConfig,
  extractDaoTreasuryAddress,
  extractGovernanceConfig,
  extractLedgerApprovers,
  extractOperatorWalletConfig,
  extractPaymentConfig,
  type GovernanceConfig,
  type InboundPaymentConfig,
  type OperatorWalletSpec,
  parseRepoSpec,
  type RepoSpec,
} from "@cogni/repo-spec";
import { serverEnv } from "@/shared/env";

export type {
  DaoConfig,
  GovernanceConfig,
  GovernanceSchedule,
  InboundPaymentConfig,
  LedgerConfig,
  LedgerPoolConfig,
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

// ---------------------------------------------------------------------------
// DAO config — cogni_dao section (for governance signal execution + review deep links)
// ---------------------------------------------------------------------------

let cachedDaoConfig: DaoConfig | null | undefined;

/**
 * DAO governance configuration from repo-spec.
 * Returns null if cogni_dao section is missing or incomplete.
 * All five fields must be present for the config to be valid.
 */
export function getDaoConfig(): DaoConfig | null {
  if (cachedDaoConfig !== undefined) return cachedDaoConfig;

  const spec = loadRepoSpec();
  cachedDaoConfig = extractDaoConfig(spec);
  return cachedDaoConfig;
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
 * Whether a wallet is in the ledger approver allowlist.
 * Case-insensitive; returns false for null/empty wallets (fail-closed).
 * Single source of truth for the `(admin)/` gate, the session `isApprover`
 * hint, and write-route enforcement.
 */
export function isLedgerApprover(wallet: string | null | undefined): boolean {
  if (!wallet) return false;
  return getLedgerApprovers().includes(wallet.toLowerCase());
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
 * DAO treasury address from repo-spec (cogni_dao.dao_contract).
 * Returns undefined if not present.
 */
export function getDaoTreasuryAddress(): string | undefined {
  if (cachedDaoTreasuryAddress !== null) return cachedDaoTreasuryAddress;

  const spec = loadRepoSpec();
  cachedDaoTreasuryAddress = extractDaoTreasuryAddress(spec);
  return cachedDaoTreasuryAddress;
}
