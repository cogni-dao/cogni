// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/repo-spec-builder`
 * Purpose: Unit tests for the complete-repo-spec YAML builder.
 * Scope: Output shape, required fields, chain mapping, unsupported chain rejection.
 * Side-effects: none
 * Links: src/features/nodes/repo-spec-builder.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import { buildCompleteRepoSpecYaml } from "@/features/nodes/repo-spec-builder";

const FIXTURE = {
  nodeId: "00000000-0000-0000-0000-000000000001",
  chainId: 8453,
  daoAddress: "0xdao0000000000000000000000000000000000dao",
  pluginAddress: "0xplugin000000000000000000000000000plugin0",
  signalAddress: "0xsignal000000000000000000000000000signal0",
  operatorWalletAddress: "0xwallet000000000000000000000000000wallet0",
  splitAddress: "0xsplit0000000000000000000000000000split00",
};

describe("buildCompleteRepoSpecYaml", () => {
  it("emits all required top-level fields for an active node on Base", () => {
    const yaml = buildCompleteRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`node_id: "${FIXTURE.nodeId}"`);
    expect(yaml).toMatch(/scope_id: "[0-9a-f-]{36}"/);
    expect(yaml).toContain(`scope_key: "default"`);
    expect(yaml).toContain(`schema_version: "0.1.4"`);
  });

  it("emits the full cogni_dao block", () => {
    const yaml = buildCompleteRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`dao_contract: "${FIXTURE.daoAddress}"`);
    expect(yaml).toContain(`plugin_contract: "${FIXTURE.pluginAddress}"`);
    expect(yaml).toContain(`signal_contract: "${FIXTURE.signalAddress}"`);
    expect(yaml).toContain(`chain_id: "8453"`);
  });

  it("emits operator_wallet.address", () => {
    const yaml = buildCompleteRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`address: "${FIXTURE.operatorWalletAddress}"`);
  });

  it("emits payments_in.credits_topup with the Split address and Base chain key", () => {
    const yaml = buildCompleteRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`provider: cogni-usdc-backend-v1`);
    expect(yaml).toContain(`receiving_address: "${FIXTURE.splitAddress}"`);
    expect(yaml).toMatch(/allowed_chains:\s*\n\s*- Base/);
    expect(yaml).toMatch(/allowed_tokens:\s*\n\s*- USDC/);
  });

  it("emits payments.status: active", () => {
    const yaml = buildCompleteRepoSpecYaml(FIXTURE);
    expect(yaml).toMatch(/payments:\s*\n\s*status: active/);
  });

  it("maps Sepolia chain id correctly", () => {
    const yaml = buildCompleteRepoSpecYaml({ ...FIXTURE, chainId: 11155111 });
    expect(yaml).toContain(`chain_id: "11155111"`);
    expect(yaml).toMatch(/allowed_chains:\s*\n\s*- Sepolia/);
  });

  it("rejects unsupported chain ids", () => {
    expect(() => buildCompleteRepoSpecYaml({ ...FIXTURE, chainId: 1 })).toThrow(
      /Unsupported chainId/
    );
  });

  it("derives scope_id deterministically from node_id (uuidv5)", () => {
    const a = buildCompleteRepoSpecYaml(FIXTURE);
    const b = buildCompleteRepoSpecYaml(FIXTURE);
    const idA = a.match(/scope_id: "([^"]+)"/)?.[1];
    const idB = b.match(/scope_id: "([^"]+)"/)?.[1];
    expect(idA).toBeDefined();
    expect(idA).toBe(idB);
  });
});
