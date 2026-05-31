// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/repo-spec-builder`
 * Purpose: Unit tests for the pending-activation repo-spec YAML builder.
 * Scope: Output shape, governance fields, payment activation boundary.
 * Side-effects: none
 * Links: src/features/nodes/repo-spec-builder.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import { buildPendingActivationRepoSpecYaml } from "@/features/nodes/repo-spec-builder";

const FIXTURE = {
  nodeId: "00000000-0000-4000-8000-000000000001",
  chainId: 8453,
  daoAddress: "0xdao0000000000000000000000000000000000dao",
  pluginAddress: "0xplugin000000000000000000000000000plugin0",
  signalAddress: "0xsignal000000000000000000000000000signal0",
};

describe("buildPendingActivationRepoSpecYaml", () => {
  it("emits all required top-level identity fields", () => {
    const yaml = buildPendingActivationRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`node_id: "${FIXTURE.nodeId}"`);
    expect(yaml).toMatch(/scope_id: "[0-9a-f-]{36}"/);
    expect(yaml).toContain(`scope_key: "default"`);
    expect(yaml).toContain(`schema_version: "0.1.4"`);
  });

  it("emits the full cogni_dao block", () => {
    const yaml = buildPendingActivationRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`dao_contract: "${FIXTURE.daoAddress}"`);
    expect(yaml).toContain(`plugin_contract: "${FIXTURE.pluginAddress}"`);
    expect(yaml).toContain(`signal_contract: "${FIXTURE.signalAddress}"`);
    expect(yaml).toContain(`chain_id: "8453"`);
  });

  it("emits payments.status: pending_activation", () => {
    const yaml = buildPendingActivationRepoSpecYaml(FIXTURE);
    expect(yaml).toMatch(/payments:\s*\n\s*status: pending_activation/);
  });

  it("does not emit wallet or payment rail addresses", () => {
    const yaml = buildPendingActivationRepoSpecYaml(FIXTURE);
    expect(yaml).not.toContain("operator_wallet:");
    expect(yaml).not.toContain("payments_in:");
    expect(yaml).not.toContain("receiving_address:");
  });

  it("derives scope_id deterministically from node_id", () => {
    const a = buildPendingActivationRepoSpecYaml(FIXTURE);
    const b = buildPendingActivationRepoSpecYaml(FIXTURE);
    const idA = a.match(/scope_id: "([^"]+)"/)?.[1];
    const idB = b.match(/scope_id: "([^"]+)"/)?.[1];
    expect(idA).toBeDefined();
    expect(idA).toBe(idB);
  });
});
