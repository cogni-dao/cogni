// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/attribution-ledger/signing`
 * Purpose: Unit tests for buildCanonicalMessage (deprecated), buildEIP712TypedData, and computeApproverSetHash.
 * Scope: Asserts exact byte output, deterministic hashing, and EIP-712 typed data structure. Does not test on-chain verification.
 * Invariants: SIGNATURE_SCOPE_BOUND, APPROVERS_PINNED_AT_REVIEW, EIP712_DETERMINISTIC.
 * Side-effects: none
 * Links: packages/attribution-ledger/src/signing.ts
 * @internal
 */

import { createHash } from "node:crypto";
import {
  ACTOR_CONTRIBUTION_ALLOCATION_VERSION,
  ATTRIBUTION_STATEMENT_TYPES,
  buildActorContributionAllocationTypedData,
  buildCanonicalMessage,
  buildEIP712TypedData,
  computeApproverSetHash,
  EIP712_DEPLOYMENT_ENVIRONMENTS,
  EIP712_DOMAIN_NAME,
  EIP712_DOMAIN_VERSION,
  freezeActorContributionAllocation,
  parseEIP712DeploymentEnvironment,
} from "@cogni/attribution-ledger";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";

describe("buildCanonicalMessage", () => {
  const params = {
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    scopeId: "a28a8b1e-1f9d-5cd5-9329-569e4819feda",
    epochId: "42",
    finalAllocationSetHash: "abc123def456",
    poolTotalCredits: "10000",
  };

  it("starts with version header", () => {
    const msg = buildCanonicalMessage(params);
    expect(msg.startsWith("Cogni Attribution Statement v1\n")).toBe(true);
  });

  it("uses \\n only (no \\r)", () => {
    const msg = buildCanonicalMessage(params);
    expect(msg).not.toContain("\r");
  });

  it("includes all SIGNATURE_SCOPE_BOUND fields", () => {
    const msg = buildCanonicalMessage(params);
    expect(msg).toContain(`Node: ${params.nodeId}`);
    expect(msg).toContain(`Scope: ${params.scopeId}`);
    expect(msg).toContain(`Epoch: ${params.epochId}`);
    expect(msg).toContain(
      `Final Allocation Hash: ${params.finalAllocationSetHash}`
    );
    expect(msg).toContain(`Pool Total: ${params.poolTotalCredits}`);
  });

  it("produces exact expected output", () => {
    const msg = buildCanonicalMessage(params);
    const expected = [
      "Cogni Attribution Statement v1",
      "Node: 4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
      "Scope: a28a8b1e-1f9d-5cd5-9329-569e4819feda",
      "Epoch: 42",
      "Final Allocation Hash: abc123def456",
      "Pool Total: 10000",
    ].join("\n");
    expect(msg).toBe(expected);
  });

  it("has exactly 6 lines (header + 5 fields)", () => {
    const msg = buildCanonicalMessage(params);
    expect(msg.split("\n")).toHaveLength(6);
  });

  it("is deterministic — same input produces same output", () => {
    const a = buildCanonicalMessage(params);
    const b = buildCanonicalMessage(params);
    expect(a).toBe(b);
  });
});

describe("computeApproverSetHash", () => {
  it("returns a hex SHA-256 hash", async () => {
    const hash = await computeApproverSetHash([
      "0x1234567890abcdef1234567890abcdef12345678",
    ]);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is case-insensitive (lowercase normalizes)", async () => {
    const upper = await computeApproverSetHash([
      "0xABCDEF1234567890ABCDEF1234567890ABCDEF12",
    ]);
    const lower = await computeApproverSetHash([
      "0xabcdef1234567890abcdef1234567890abcdef12",
    ]);
    expect(upper).toBe(lower);
  });

  it("is order-independent (sorted before hashing)", async () => {
    const a = await computeApproverSetHash(["0xaaa", "0xbbb", "0xccc"]);
    const b = await computeApproverSetHash(["0xccc", "0xaaa", "0xbbb"]);
    expect(a).toBe(b);
  });

  it("produces expected hash for known input", async () => {
    const hash = await computeApproverSetHash(["0xaaa", "0xbbb"]);
    const expected = createHash("sha256").update("0xaaa,0xbbb").digest("hex");
    expect(hash).toBe(expected);
  });

  it("is deterministic", async () => {
    const addrs = [
      "0x1234567890abcdef1234567890abcdef12345678",
      "0xfedcba0987654321fedcba0987654321fedcba09",
    ];
    const a = await computeApproverSetHash(addrs);
    const b = await computeApproverSetHash(addrs);
    expect(a).toBe(b);
  });

  it("different sets produce different hashes", async () => {
    const a = await computeApproverSetHash(["0xaaa"]);
    const b = await computeApproverSetHash(["0xbbb"]);
    expect(a).not.toBe(b);
  });
});

describe("buildEIP712TypedData", () => {
  const params = {
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    scopeId: "a28a8b1e-1f9d-5cd5-9329-569e4819feda",
    epochId: "42",
    finalAllocationSetHash: "abc123def456",
    poolTotalCredits: "10000",
    chainId: 8453,
    deploymentEnvironment: "candidate-a" as const,
  };

  it("returns correct domain with name, version, and chainId", () => {
    const data = buildEIP712TypedData(params);
    expect(data.domain).toEqual({
      name: EIP712_DOMAIN_NAME,
      version: EIP712_DOMAIN_VERSION,
      chainId: 8453,
    });
  });

  it("returns AttributionStatement as primaryType", () => {
    const data = buildEIP712TypedData(params);
    expect(data.primaryType).toBe("AttributionStatement");
  });

  it("includes all SIGNATURE_SCOPE_BOUND fields in message", () => {
    const data = buildEIP712TypedData(params);
    expect(data.message).toEqual({
      nodeId: params.nodeId,
      scopeId: params.scopeId,
      epochId: params.epochId,
      deploymentEnvironment: params.deploymentEnvironment,
      finalAllocationSetHash: params.finalAllocationSetHash,
      poolTotalCredits: params.poolTotalCredits,
    });
  });

  it("exports correct type definitions matching viem expectations", () => {
    const data = buildEIP712TypedData(params);
    expect(data.types).toBe(ATTRIBUTION_STATEMENT_TYPES);
    expect(data.types.AttributionStatement).toHaveLength(6);
    const fieldNames = data.types.AttributionStatement.map((f) => f.name);
    expect(fieldNames).toEqual([
      "nodeId",
      "scopeId",
      "epochId",
      "deploymentEnvironment",
      "finalAllocationSetHash",
      "poolTotalCredits",
    ]);
  });

  it("is deterministic — same input produces identical output", () => {
    const a = buildEIP712TypedData(params);
    const b = buildEIP712TypedData(params);
    expect(a).toEqual(b);
  });

  it("different chainId produces different domain", () => {
    const a = buildEIP712TypedData({ ...params, chainId: 8453 });
    const b = buildEIP712TypedData({ ...params, chainId: 11155111 });
    expect(a.domain.chainId).not.toBe(b.domain.chainId);
    // message is same — only domain differs
    expect(a.message).toEqual(b.message);
  });

  it("different epochId produces different message", () => {
    const a = buildEIP712TypedData({ ...params, epochId: "42" });
    const b = buildEIP712TypedData({ ...params, epochId: "43" });
    expect(a.message.epochId).not.toBe(b.message.epochId);
    // domain is same — only message differs
    expect(a.domain).toEqual(b.domain);
  });

  it("accepts only explicit signing deployment environments", () => {
    for (const environment of EIP712_DEPLOYMENT_ENVIRONMENTS) {
      expect(parseEIP712DeploymentEnvironment(environment)).toBe(environment);
    }
    expect(() => parseEIP712DeploymentEnvironment(undefined)).toThrow(
      /DEPLOY_ENVIRONMENT/
    );
    expect(() => parseEIP712DeploymentEnvironment("candidate-b")).toThrow(
      /DEPLOY_ENVIRONMENT/
    );
  });
});

describe("EIP-712 sign/verify round-trip", () => {
  // Deterministic test private key — never used on-chain
  const TEST_PRIVATE_KEY =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);

  const typedData = buildEIP712TypedData({
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    scopeId: "a28a8b1e-1f9d-5cd5-9329-569e4819feda",
    epochId: "42",
    finalAllocationSetHash: "abc123def456",
    poolTotalCredits: "10000",
    chainId: 8453,
    deploymentEnvironment: "candidate-a",
  });

  it("signTypedData → verifyTypedData recovers the signer address", async () => {
    const signature = await account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const recovered = await verifyTypedData({
      address: account.address,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });

    expect(recovered).toBe(true);
  });

  it("verifyTypedData returns false for a different address", async () => {
    const signature = await account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });

    const otherAccount = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"
    );

    const valid = await verifyTypedData({
      address: otherAccount.address,
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
      signature,
    });

    expect(valid).toBe(false);
  });

  it.each([
    "preview",
    "production",
  ] as const)("candidate-a signature cannot replay in %s", async (deploymentEnvironment) => {
    const signature = await account.signTypedData({
      domain: typedData.domain,
      types: typedData.types,
      primaryType: typedData.primaryType,
      message: typedData.message,
    });
    const replayTarget = buildEIP712TypedData({
      ...typedData.message,
      chainId: typedData.domain.chainId,
      deploymentEnvironment,
    });

    await expect(
      verifyTypedData({
        address: account.address,
        domain: replayTarget.domain,
        types: replayTarget.types,
        primaryType: replayTarget.primaryType,
        message: replayTarget.message,
        signature,
      })
    ).resolves.toBe(false);
  });

  it("v1 signature cannot replay against v2 typed data", async () => {
    const legacyTypes = {
      AttributionStatement: [
        { name: "nodeId", type: "string" },
        { name: "scopeId", type: "string" },
        { name: "epochId", type: "string" },
        { name: "finalAllocationSetHash", type: "string" },
        { name: "poolTotalCredits", type: "string" },
      ],
    } as const;
    const { deploymentEnvironment: _deploymentEnvironment, ...legacyMessage } =
      typedData.message;
    const legacySignature = await account.signTypedData({
      domain: {
        name: EIP712_DOMAIN_NAME,
        version: "1",
        chainId: typedData.domain.chainId,
      },
      types: legacyTypes,
      primaryType: "AttributionStatement",
      message: legacyMessage,
    });

    await expect(
      verifyTypedData({
        address: account.address,
        domain: typedData.domain,
        types: typedData.types,
        primaryType: typedData.primaryType,
        message: typedData.message,
        signature: legacySignature,
      })
    ).resolves.toBe(false);
  });
});

describe("ActorContributionAllocation v1", () => {
  const facts = {
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    scopeId: "a28a8b1e-1f9d-5cd5-9329-569e4819feda",
    epochId: "43",
    receiptId: "github:pr:cogni-dao/cogni:2659",
    earnedByActorId: "flock-leader-actor",
    beneficiaryActorId: "derek-actor",
    beneficiaryPolicyId: "policy-flock-leader-derek-v1",
    beneficiaryPolicyVersion: "flock-leader-beneficiary.v1",
    contributionCutoff: "2026-10-09T12:34:56.000Z",
    sourceEvidence: {
      provider: "github",
      immutableExternalId: "295942454",
      payloadHash: "payload-hash",
      bindingEvidenceEventId: "binding-event-1",
    },
  } as const;

  it("keeps the AI earner separate from the explicitly selected human beneficiary", async () => {
    const allocation = await freezeActorContributionAllocation(facts);
    expect(allocation.contractVersion).toBe(
      ACTOR_CONTRIBUTION_ALLOCATION_VERSION
    );
    expect(allocation.earnedByActorId).toBe("flock-leader-actor");
    expect(allocation.beneficiaryActorId).toBe("derek-actor");
    expect(allocation.earnedByActorId).not.toBe(allocation.beneficiaryActorId);
  });

  it("is deterministic and signs the cutoff, policy, and source evidence", async () => {
    const [first, second] = await Promise.all([
      freezeActorContributionAllocation(facts),
      freezeActorContributionAllocation({
        ...facts,
        sourceEvidence: {
          bindingEvidenceEventId: "binding-event-1",
          payloadHash: "payload-hash",
          immutableExternalId: "295942454",
          provider: "github",
        },
      }),
    ]);
    expect(first).toEqual(second);
    const typedData = buildActorContributionAllocationTypedData({
      allocation: first,
      chainId: 8453,
      deploymentEnvironment: "candidate-a",
    });
    expect(typedData.message).toMatchObject({
      allocationRef: first.allocationRef,
      earnedByActorId: "flock-leader-actor",
      beneficiaryActorId: "derek-actor",
      beneficiaryPolicyVersion: "flock-leader-beneficiary.v1",
      contributionCutoff: "2026-10-09T12:34:56.000Z",
      sourceEvidenceHash: first.sourceEvidenceHash,
    });
  });

  it("does not mutate the legacy AttributionStatement v2 envelope", () => {
    const legacy = buildEIP712TypedData({
      nodeId: facts.nodeId,
      scopeId: facts.scopeId,
      epochId: "42",
      finalAllocationSetHash: "abc123def456",
      poolTotalCredits: "10000",
      chainId: 8453,
      deploymentEnvironment: "candidate-a",
    });
    expect(legacy.domain).toEqual({
      name: "Cogni Attribution",
      version: "2",
      chainId: 8453,
    });
    expect(legacy.primaryType).toBe("AttributionStatement");
    expect(Object.keys(legacy.message)).toEqual([
      "nodeId",
      "scopeId",
      "epochId",
      "deploymentEnvironment",
      "finalAllocationSetHash",
      "poolTotalCredits",
    ]);
  });
});
