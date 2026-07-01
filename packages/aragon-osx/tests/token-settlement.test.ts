// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/aragon-osx/tests/token-settlement`
 * Purpose: Unit tests for the mint-per-epoch reconciliation of isSettlementInventoryReady.
 * Scope: Pure readiness tests; no chain, DB, or filesystem I/O.
 * Invariants: TOKEN_SETTLEMENT_MINT_AUTHORITY_IS_READINESS.
 * Side-effects: none
 * Links: packages/aragon-osx/src/token-settlement.ts, docs/spec/tokenomics.md
 * @internal
 */

import {
  buildDaoTokenSettlementModel,
  type DaoTokenInventoryRef,
  isSettlementInventoryReady,
} from "@cogni/aragon-osx";
import { describe, expect, it } from "vitest";

const DAO = "0x00000000000000000000000000000000000000d0" as const;

describe("isSettlementInventoryReady — mint-per-epoch (dao_minter)", () => {
  it("is READY when the DAO holds mint permission and the mint executed — regardless of parked balance", () => {
    const inventory: DaoTokenInventoryRef = {
      kind: "dao_minter",
      holder: DAO,
      amount: 0n, // nothing pre-minted; balance must NOT gate readiness
      daoControlled: true,
      daoHoldsMintPermission: true,
      mintExecuted: true,
    };
    expect(isSettlementInventoryReady(inventory)).toBe(true);
  });

  it("is NOT ready when the DAO has mint permission but the epoch mint has not executed", () => {
    const inventory: DaoTokenInventoryRef = {
      kind: "dao_minter",
      holder: DAO,
      amount: 999n,
      daoControlled: true,
      daoHoldsMintPermission: true,
      mintExecuted: false,
    };
    expect(isSettlementInventoryReady(inventory)).toBe(false);
  });

  it("is NOT ready without mint permission even if a balance is parked", () => {
    const inventory: DaoTokenInventoryRef = {
      kind: "dao_minter",
      holder: DAO,
      amount: 1_000_000n,
      daoControlled: true,
      daoHoldsMintPermission: false,
      mintExecuted: true,
    };
    expect(isSettlementInventoryReady(inventory)).toBe(false);
  });

  it("is NOT ready when not DAO-controlled", () => {
    const inventory: DaoTokenInventoryRef = {
      kind: "dao_minter",
      holder: DAO,
      amount: 0n,
      daoControlled: false,
      daoHoldsMintPermission: true,
      mintExecuted: true,
    };
    expect(isSettlementInventoryReady(inventory)).toBe(false);
  });

  it("surfaces a mint-authority-worded blocker for a not-ready dao_minter", () => {
    const model = buildDaoTokenSettlementModel({
      inventory: {
        kind: "dao_minter",
        holder: DAO,
        amount: 0n,
        daoControlled: true,
        daoHoldsMintPermission: true,
        mintExecuted: false,
      },
    });
    expect(model.phase).toBe("formation_probe_only");
    const inventoryBlocker = model.blockers.find(
      (b) => b.code === "inventory_not_dao_controlled"
    );
    expect(inventoryBlocker).toBeDefined();
    expect(inventoryBlocker?.message).toMatch(/MINT_PERMISSION/);
  });
});

describe("isSettlementInventoryReady — legacy parked-balance kinds unchanged", () => {
  it("still requires a positive DAO-controlled balance for emissions_holder", () => {
    expect(
      isSettlementInventoryReady({
        kind: "emissions_holder",
        holder: DAO,
        amount: 1n,
        daoControlled: true,
      })
    ).toBe(true);
    expect(
      isSettlementInventoryReady({
        kind: "emissions_holder",
        holder: DAO,
        amount: 0n,
        daoControlled: true,
      })
    ).toBe(false);
  });

  it("treats a genesis_holder mint as a formation probe (never ready)", () => {
    expect(
      isSettlementInventoryReady({
        kind: "genesis_holder",
        holder: DAO,
        amount: 1_000n,
        daoControlled: true,
      })
    ).toBe(false);
  });
});
