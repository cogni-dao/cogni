// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/config`
 * Purpose: Barrel export for governance-backed configuration helpers sourced from .cogni/repo-spec.yaml.
 * Scope: Server-only helpers; reads versioned config and exposes node identity, typed payment config, governance schedule config, and ledger approver allowlist; does not expose env overrides or client-facing APIs.
 * Invariants: No env overrides; callers import from this entry point only.
 * Side-effects: none (delegates to repoSpec.server.ts for IO)
 * Links: .cogni/repo-spec.yaml
 * @public
 */

export {
  type DaoConfig,
  type GovernanceConfig,
  type GovernanceSchedule,
  getDaoConfig,
  getDaoTreasuryAddress,
  getGovernanceConfig,
  getLedgerApprovers,
  getNodeId,
  getOperatorWalletConfig,
  getPaymentConfig,
  getScopeId,
  type InboundPaymentConfig,
  isLedgerApprover,
} from "./repoSpec.server";
