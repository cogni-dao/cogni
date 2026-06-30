// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/token-settlement`
 * Purpose: Pure DAO ownership-token settlement data model from formation inventory to Merkle claims.
 * Scope: Defines typed lifecycle/readiness helpers only; does not deploy contracts, read chain state, or persist manifests.
 * Invariants:
 * - TOKEN_SETTLEMENT_MINT_AUTHORITY_IS_READINESS: under the mint-per-epoch model, inventory
 *   readiness is DAO mint authority (MINT_PERMISSION on the GovernanceERC20) + an executed
 *   mint into the distributor — NOT a pre-minted balance parked in a vault. A genesis-holder
 *   mint is only a formation probe (tokenomics.md Walk reconciliation).
 * - TOKEN_SETTLEMENT_STATEMENT_BOUND: claim manifests must bind to a finalized signed attribution statement.
 * - TOKEN_SETTLEMENT_FUNDING_MATCHES_ROOT: funding must match the manifest amount and root.
 * Side-effects: none
 * Links: docs/spec/tokenomics.md, docs/spec/financial-ledger.md
 * @public
 */

import { isAddress } from "viem";

import type { DaoTokenMerkleDistribution } from "./token-distribution";
import type { Hex, HexAddress } from "./types";

export type DaoTokenInventoryKind =
  | "genesis_holder"
  | "emissions_holder"
  | "funded_distributor"
  // Mint-per-epoch model: the DAO holds MINT_PERMISSION on the GovernanceERC20 and
  // mints supply per-epoch into the distributor. The DAO contract is the
  // `emissions_holder` (the minter) itself, NOT a vault parking a pre-minted balance.
  | "dao_minter";

export type DaoTokenSettlementPhase =
  | "formation_probe_only"
  | "inventory_ready"
  | "statement_bound"
  | "manifest_ready"
  | "claimable";

export type DaoTokenSettlementBlockerCode =
  | "inventory_not_dao_controlled"
  | "statement_missing"
  | "statement_not_finalized"
  | "statement_hash_mismatch"
  | "claimants_unresolved"
  | "manifest_missing"
  | "funding_missing"
  | "funding_amount_mismatch"
  | "funding_root_mismatch"
  | "distributor_missing";

export interface DaoTokenInventoryRef {
  readonly kind: DaoTokenInventoryKind;
  readonly holder: HexAddress;
  /**
   * On-chain balance held by `holder`. Under the legacy parked-balance kinds
   * (`emissions_holder` / `funded_distributor`) this gates readiness. Under
   * `dao_minter` it is informational only — readiness is mint authority + an
   * executed mint, NOT this balance (nothing is pre-minted).
   */
  readonly amount: bigint;
  readonly daoControlled: boolean;
  /**
   * `dao_minter` only: the DAO holds MINT_PERMISSION on the GovernanceERC20
   * (granted by Aragon's TokenVotingSetup at formation). The minting authority,
   * not a balance, is what makes per-epoch emissions possible.
   */
  readonly daoHoldsMintPermission?: boolean;
  /**
   * `dao_minter` only: the per-epoch `mint(distributor, amount)` under a signed
   * root has executed on-chain. This — not a parked balance — is what makes the
   * epoch's inventory distributable.
   */
  readonly mintExecuted?: boolean;
}

export interface SignedAttributionStatementRef {
  readonly epochId: string;
  readonly nodeId: string;
  readonly scopeId: string;
  readonly statementHash: string;
  readonly finalized: boolean;
  readonly signatureHash?: Hex;
  readonly signer?: HexAddress;
  readonly unresolvedClaimantCount: number;
}

export interface DaoTokenDistributorFundingRef {
  readonly distributor: HexAddress;
  readonly merkleRoot: Hex;
  readonly amount: bigint;
  readonly fundingTxHash: Hex;
  readonly publisher: HexAddress;
  readonly publishedAt: string;
}

export interface DaoTokenSettlementModelInput {
  readonly inventory: DaoTokenInventoryRef;
  readonly signedStatement?: SignedAttributionStatementRef;
  readonly distribution?: DaoTokenMerkleDistribution;
  readonly funding?: DaoTokenDistributorFundingRef;
}

export interface DaoTokenSettlementBlocker {
  readonly code: DaoTokenSettlementBlockerCode;
  readonly message: string;
}

export interface DaoTokenSettlementModel {
  readonly phase: DaoTokenSettlementPhase;
  readonly inventory: DaoTokenInventoryRef;
  readonly signedStatement?: SignedAttributionStatementRef;
  readonly distribution?: DaoTokenMerkleDistribution;
  readonly funding?: DaoTokenDistributorFundingRef;
  readonly blockers: readonly DaoTokenSettlementBlocker[];
  readonly claimable: boolean;
}

export function buildDaoTokenSettlementModel(
  input: DaoTokenSettlementModelInput
): DaoTokenSettlementModel {
  validateInventory(input.inventory);
  if (input.signedStatement) validateSignedStatement(input.signedStatement);
  if (input.funding) validateFunding(input.funding);

  const blockers: DaoTokenSettlementBlocker[] = [];
  addInventoryBlockers(blockers, input.inventory);
  addStatementBlockers(blockers, input.signedStatement);
  addDistributionBlockers(blockers, input.signedStatement, input.distribution);
  addFundingBlockers(blockers, input.distribution, input.funding);

  return {
    phase: resolveSettlementPhase(input, blockers),
    inventory: input.inventory,
    signedStatement: input.signedStatement,
    distribution: input.distribution,
    funding: input.funding,
    blockers,
    claimable: blockers.length === 0,
  };
}

export function isSettlementInventoryReady(
  inventory: DaoTokenInventoryRef
): boolean {
  validateInventory(inventory);
  if (!inventory.daoControlled) return false;

  // Mint-per-epoch (Walk): readiness is DAO mint authority + an executed mint
  // into the distributor — NOT a pre-minted parked balance. The DAO contract is
  // the emissions holder (the minter); `amount` is informational, never gating.
  if (inventory.kind === "dao_minter") {
    return (
      inventory.daoHoldsMintPermission === true &&
      inventory.mintExecuted === true
    );
  }

  // Legacy parked-balance kinds: a real, DAO-controlled balance is required.
  return (
    inventory.amount > 0n &&
    (inventory.kind === "emissions_holder" ||
      inventory.kind === "funded_distributor")
  );
}

function addInventoryBlockers(
  blockers: DaoTokenSettlementBlocker[],
  inventory: DaoTokenInventoryRef
): void {
  if (!isSettlementInventoryReady(inventory)) {
    blockers.push({
      code: "inventory_not_dao_controlled",
      message:
        inventory.kind === "dao_minter"
          ? "Settlement requires the DAO to hold MINT_PERMISSION on the GovernanceERC20 and to have executed the per-epoch mint into the distributor; nothing is pre-minted."
          : "Settlement requires DAO-controlled emissions inventory or a funded distributor; a genesis holder mint is only a formation probe.",
    });
  }
}

function addStatementBlockers(
  blockers: DaoTokenSettlementBlocker[],
  statement: SignedAttributionStatementRef | undefined
): void {
  if (!statement) {
    blockers.push({
      code: "statement_missing",
      message: "A finalized signed attribution statement is required.",
    });
    return;
  }
  if (!statement.finalized) {
    blockers.push({
      code: "statement_not_finalized",
      message: "The attribution statement must be finalized before settlement.",
    });
  }
  if (statement.unresolvedClaimantCount > 0) {
    blockers.push({
      code: "claimants_unresolved",
      message:
        "All claimants must resolve to wallet addresses before on-chain claims are published.",
    });
  }
}

function addDistributionBlockers(
  blockers: DaoTokenSettlementBlocker[],
  statement: SignedAttributionStatementRef | undefined,
  distribution: DaoTokenMerkleDistribution | undefined
): void {
  if (!distribution) {
    blockers.push({
      code: "manifest_missing",
      message:
        "A Merkle distribution manifest built from the signed statement is required.",
    });
    return;
  }
  if (
    statement &&
    distribution.statementHash.toLowerCase() !==
      statement.statementHash.toLowerCase()
  ) {
    blockers.push({
      code: "statement_hash_mismatch",
      message:
        "Merkle distribution statementHash must match the signed attribution statement.",
    });
  }
}

function addFundingBlockers(
  blockers: DaoTokenSettlementBlocker[],
  distribution: DaoTokenMerkleDistribution | undefined,
  funding: DaoTokenDistributorFundingRef | undefined
): void {
  if (!funding) {
    blockers.push({
      code: "funding_missing",
      message:
        "The distributor must be funded before the Merkle root is claimable.",
    });
    return;
  }
  if (!distribution) return;
  if (funding.amount !== distribution.distributionAmount) {
    blockers.push({
      code: "funding_amount_mismatch",
      message: "Funding amount must equal the distribution manifest amount.",
    });
  }
  if (
    funding.merkleRoot.toLowerCase() !== distribution.merkleRoot.toLowerCase()
  ) {
    blockers.push({
      code: "funding_root_mismatch",
      message: "Funding root must equal the distribution manifest Merkle root.",
    });
  }
}

function resolveSettlementPhase(
  input: DaoTokenSettlementModelInput,
  blockers: readonly DaoTokenSettlementBlocker[]
): DaoTokenSettlementPhase {
  if (blockers.length === 0) return "claimable";
  if (!isSettlementInventoryReady(input.inventory)) {
    return "formation_probe_only";
  }
  if (!input.signedStatement) return "inventory_ready";
  if (!input.distribution) return "statement_bound";
  return "manifest_ready";
}

function validateInventory(inventory: DaoTokenInventoryRef): void {
  if (!isAddress(inventory.holder)) {
    throw new RangeError("inventory holder must be a valid EVM address");
  }
  if (inventory.amount < 0n) {
    throw new RangeError("inventory amount must be non-negative");
  }
}

function validateSignedStatement(
  statement: SignedAttributionStatementRef
): void {
  if (statement.epochId.trim().length === 0) {
    throw new RangeError("epochId must be non-empty");
  }
  if (statement.nodeId.trim().length === 0) {
    throw new RangeError("nodeId must be non-empty");
  }
  if (statement.scopeId.trim().length === 0) {
    throw new RangeError("scopeId must be non-empty");
  }
  if (statement.statementHash.trim().length === 0) {
    throw new RangeError("statementHash must be non-empty");
  }
  if (statement.unresolvedClaimantCount < 0) {
    throw new RangeError("unresolvedClaimantCount must be non-negative");
  }
  if (statement.signer && !isAddress(statement.signer)) {
    throw new RangeError("statement signer must be a valid EVM address");
  }
}

function validateFunding(funding: DaoTokenDistributorFundingRef): void {
  if (!isAddress(funding.distributor)) {
    throw new RangeError("distributor must be a valid EVM address");
  }
  if (!isAddress(funding.publisher)) {
    throw new RangeError("publisher must be a valid EVM address");
  }
  if (funding.amount <= 0n) {
    throw new RangeError("funding amount must be positive");
  }
  if (funding.publishedAt.trim().length === 0) {
    throw new RangeError("publishedAt must be non-empty");
  }
}
