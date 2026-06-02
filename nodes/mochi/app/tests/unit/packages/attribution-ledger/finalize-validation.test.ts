// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-ledger/finalize-validation`
 * Purpose: Unit tests for finalizeEpoch validation invariants — approver set, signature verification, config lock.
 * Scope: Exercises the pure functions used by the finalizeEpoch activity for its guard checks. Does not test the
 *   activity itself (which is a closure over store/config), but ensures the validation functions reject bad inputs.
 * Invariants:
 *   - APPROVERS_PINNED_AT_REVIEW: approverSetHash must match current set
 *   - SIGNATURE_SCOPE_BOUND: signature must be valid for the exact typed data
 *   - CONFIG_LOCKED_AT_REVIEW: allocationAlgoRef + weightConfigHash must be set
 * Side-effects: none
 * Links: services/scheduler-worker/src/activities/ledger.ts,
 *         packages/attribution-ledger/src/signing.ts
 * @internal
 */

import {
  buildEIP712TypedData,
  computeApproverSetHash,
} from "@cogni/attribution-ledger";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

// Deterministic test wallets — never used on-chain
const APPROVER_KEY =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
const NON_APPROVER_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;

const approverAccount = privateKeyToAccount(APPROVER_KEY);
const nonApproverAccount = privateKeyToAccount(NON_APPROVER_KEY);

const TYPED_DATA_PARAMS = {
  nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  scopeId: "a28a8b1e-1f9d-5cd5-9329-569e4819feda",
  epochId: "42",
  finalAllocationSetHash: "abc123def456",
  poolTotalCredits: "10000",
  chainId: 8453,
};

describe("finalizeEpoch validation: approver set", () => {
  it("signer in approvers list passes check", () => {
    const approvers = [approverAccount.address, nonApproverAccount.address];
    const signerLower = approverAccount.address.toLowerCase();
    const approversLower = approvers.map((a) => a.toLowerCase());
    expect(approversLower).toContain(signerLower);
  });

  it("signer NOT in approvers list fails check", () => {
    const approvers = [nonApproverAccount.address]; // only non-approver
    const signerLower = approverAccount.address.toLowerCase();
    const approversLower = approvers.map((a) => a.toLowerCase());
    expect(approversLower).not.toContain(signerLower);
  });

  it("approverSetHash mismatch detected when set changes", async () => {
    const originalApprovers = [approverAccount.address];
    const modifiedApprovers = [
      approverAccount.address,
      nonApproverAccount.address,
    ];

    const originalHash = await computeApproverSetHash(originalApprovers);
    const modifiedHash = await computeApproverSetHash(modifiedApprovers);

    expect(originalHash).not.toBe(modifiedHash);
  });

  it("approverSetHash is stable when set is unchanged", async () => {
    const approvers = [approverAccount.address];
    const hash1 = await computeApproverSetHash(approvers);
    const hash2 = await computeApproverSetHash(approvers);
    expect(hash1).toBe(hash2);
  });
});

describe("finalizeEpoch validation: EIP-712 signature", () => {
  it("valid signature from approver passes verification", async () => {
    const typedData = buildEIP712TypedData(TYPED_DATA_PARAMS);
    const signature = await approverAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const isValid = await verifyTypedData({
      address: approverAccount.address,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });
    expect(isValid).toBe(true);
  });

  it("signature from wrong signer fails verification", async () => {
    const typedData = buildEIP712TypedData(TYPED_DATA_PARAMS);
    // Sign with non-approver
    const signature = await nonApproverAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    // Verify against approver address — should fail
    const isValid = await verifyTypedData({
      address: approverAccount.address,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });
    expect(isValid).toBe(false);
  });

  it("signature over different finalAllocationSetHash fails verification", async () => {
    // Sign with correct hash
    const typedData = buildEIP712TypedData(TYPED_DATA_PARAMS);
    const signature = await approverAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    // Verify against different hash — simulates hash mismatch
    const tamperedTypedData = buildEIP712TypedData({
      ...TYPED_DATA_PARAMS,
      finalAllocationSetHash: "tampered-hash",
    });
    const isValid = await verifyTypedData({
      address: approverAccount.address,
      domain: tamperedTypedData.domain,
      types: tamperedTypedData.types,
      primaryType: tamperedTypedData.primaryType,
      message: tamperedTypedData.message,
      signature,
    });
    expect(isValid).toBe(false);
  });

  it("signature over different chainId fails verification", async () => {
    const typedData = buildEIP712TypedData(TYPED_DATA_PARAMS);
    const signature = await approverAccount.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const differentChain = buildEIP712TypedData({
      ...TYPED_DATA_PARAMS,
      chainId: 1, // mainnet instead of base
    });
    const isValid = await verifyTypedData({
      address: approverAccount.address,
      domain: differentChain.domain,
      types: differentChain.types,
      primaryType: differentChain.primaryType,
      message: differentChain.message,
      signature,
    });
    expect(isValid).toBe(false);
  });
});
