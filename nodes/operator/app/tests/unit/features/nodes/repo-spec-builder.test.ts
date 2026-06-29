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
import { parse as parseYaml } from "yaml";

import { buildPendingActivationRepoSpecYaml } from "@/features/nodes/repo-spec-builder";

const FIXTURE = {
  nodeId: "00000000-0000-4000-8000-000000000001",
  chainId: 8453,
  daoAddress: "0xdao0000000000000000000000000000000000dao",
  pluginAddress: "0xplugin000000000000000000000000000plugin0",
  signalAddress: "0xsignal000000000000000000000000000signal0",
  tokenAddress: "0xtoken000000000000000000000000000000token",
};

const KNOWLEDGE_REMOTE = {
  database: "knowledge_my_node",
  owner: "cogni-dao-test",
  repo: "knowledge-my-node",
  url: "https://doltremoteapi.dolthub.com/cogni-dao-test/knowledge-my-node",
};

describe("buildPendingActivationRepoSpecYaml", () => {
  it("emits all required top-level identity fields", () => {
    const yaml = buildPendingActivationRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`node_id: "${FIXTURE.nodeId}"`);
    expect(yaml).toMatch(/scope_id: "[0-9a-f-]{36}"/);
    expect(yaml).toContain(`scope_key: "default"`);
    expect(yaml).toContain(`schema_version: "0.1.4"`);
  });

  it("emits the full governance block", () => {
    const yaml = buildPendingActivationRepoSpecYaml(FIXTURE);
    expect(yaml).toContain(`dao_contract: "${FIXTURE.daoAddress}"`);
    expect(yaml).toContain(`plugin_contract: "${FIXTURE.pluginAddress}"`);
    expect(yaml).toContain(`signal_contract: "${FIXTURE.signalAddress}"`);
    expect(yaml).toContain(`chain_id: "8453"`);
    expect(parseYaml(yaml).governance).toMatchObject({
      dao_contract: FIXTURE.daoAddress,
      plugin_contract: FIXTURE.pluginAddress,
      signal_contract: FIXTURE.signalAddress,
      token_contract: FIXTURE.tokenAddress,
      chain_id: "8453",
    });
  });

  it("emits payments and distributions as pending activation", () => {
    const yaml = buildPendingActivationRepoSpecYaml(FIXTURE);
    expect(yaml).toMatch(/payments:\s*\n\s*status: pending_activation/);
    expect(yaml).toMatch(/distributions:\s*\n\s*status: pending_activation/);
  });

  it("emits the Cogni-owned DoltHub knowledge remote when provided", () => {
    const yaml = buildPendingActivationRepoSpecYaml({
      ...FIXTURE,
      knowledgeRemote: KNOWLEDGE_REMOTE,
    });
    expect(yaml).toContain(`database: "${KNOWLEDGE_REMOTE.database}"`);
    expect(yaml).toContain("provider: dolthub");
    expect(yaml).toContain(`owner: "${KNOWLEDGE_REMOTE.owner}"`);
    expect(yaml).toContain(`repo: "${KNOWLEDGE_REMOTE.repo}"`);
    expect(yaml).toContain(`url: "${KNOWLEDGE_REMOTE.url}"`);
    expect(yaml).toContain("custody: cogni-owned");
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
