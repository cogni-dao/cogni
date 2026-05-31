// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/config/repoSpec.server`
 * Purpose: Validate that repo-spec-driven inbound payment config loads correctly and rejects invalid specs.
 * Scope: Pure unit tests against getPaymentConfig(); uses a temporary cwd with fixture repo-spec files; does not assert cache identity or UI wiring.
 * Invariants: repo-spec is the single source for chainId/receivingAddress/provider; invalid specs throw clear errors.
 * Side-effects: none (temp filesystem only)
 * Links: src/shared/config/repoSpec.server.ts, .cogni/repo-spec.yaml
 * @public
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { GovernanceConfig, InboundPaymentConfig } from "@/shared/config";
import { CHAIN_ID } from "@/shared/web3";

interface RepoSpecModule {
  getPaymentConfig: () => InboundPaymentConfig;
  getGovernanceConfig: () => GovernanceConfig;
}

const TEST_NODE_ID = "00000000-0000-4000-8000-000000000001";

function writeRepoSpec(yaml: string): string {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "repo-spec-"));
  const specDir = path.join(tmpDir, ".cogni");
  fs.mkdirSync(specDir);
  fs.writeFileSync(path.join(specDir, "repo-spec.yaml"), yaml);
  return tmpDir;
}

/** Point serverEnv().COGNI_REPO_ROOT at a temp dir so loadRepoSpec finds the fixture. */
function useTmpRoot(dir: string): void {
  vi.doMock("@/shared/env", () => ({
    serverEnv: () => ({ COGNI_REPO_ROOT: dir }),
  }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

async function loadPaymentConfig(): Promise<RepoSpecModule> {
  vi.resetModules();
  return import("@/shared/config/repoSpec.server");
}

describe("getPaymentConfig (repo-spec)", () => {
  it("returns mapped inbound payment config for a valid repo-spec", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: "${CHAIN_ID}"`,
        "payments_in:",
        "  credits_topup:",
        "    provider: cogni-usdc-backend-v1",
        '    receiving_address: "0x1111111111111111111111111111111111111111"',
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      const config = getPaymentConfig();

      expect(config).toEqual({
        chainId: CHAIN_ID,
        receivingAddress: "0x1111111111111111111111111111111111111111",
        provider: "cogni-usdc-backend-v1",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws on missing or non-numeric chain_id", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        "  chain_id: not-a-number",
        "payments_in:",
        "  credits_topup:",
        "    provider: cogni-usdc-backend-v1",
        '    receiving_address: "0x1111111111111111111111111111111111111111"',
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      expect(() => getPaymentConfig()).toThrow(/Invalid cogni_dao\.chain_id/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when chain_id does not match CHAIN_ID", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: "${CHAIN_ID + 1}"`,
        "payments_in:",
        "  credits_topup:",
        "    provider: cogni-usdc-backend-v1",
        '    receiving_address: "0x1111111111111111111111111111111111111111"',
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      expect(() => getPaymentConfig()).toThrow(/Chain mismatch/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws on invalid receiving_address shape", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: "${CHAIN_ID}"`,
        "payments_in:",
        "  credits_topup:",
        "    provider: cogni-usdc-backend-v1",
        "    receiving_address: 0x1234",
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      expect(() => getPaymentConfig()).toThrow(/receiving_address/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when provider is missing or empty", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: "${CHAIN_ID}"`,
        "payments_in:",
        "  credits_topup:",
        '    receiving_address: "0x1111111111111111111111111111111111111111"',
        "    provider: ''",
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      expect(() => getPaymentConfig()).toThrow(/provider/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts chain_id as a number (not just string)", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: ${CHAIN_ID}`,
        "payments_in:",
        "  credits_topup:",
        "    provider: cogni-usdc-backend-v1",
        '    receiving_address: "0x1111111111111111111111111111111111111111"',
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      const config = getPaymentConfig();

      expect(config.chainId).toBe(CHAIN_ID);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws on invalid EVM address format (schema validation)", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: "${CHAIN_ID}"`,
        "payments_in:",
        "  credits_topup:",
        "    provider: test-provider",
        '    receiving_address: "not-an-address"',
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      expect(() => getPaymentConfig()).toThrow(/Invalid repo-spec structure/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("accepts any string values for allowed_chains (informational metadata)", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: "${CHAIN_ID}"`,
        "payments_in:",
        "  credits_topup:",
        "    provider: test-provider",
        '    receiving_address: "0x1111111111111111111111111111111111111111"',
        "    allowed_chains:",
        '      - "CustomChain"',
        '      - "AnotherChain"',
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      const config = getPaymentConfig();
      expect(config.receivingAddress).toBe(
        "0x1111111111111111111111111111111111111111"
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("throws when payments_in.credits_topup is missing", async () => {
    const tmpDir = writeRepoSpec(
      [
        `node_id: "${TEST_NODE_ID}"`,
        "cogni_dao:",
        `  chain_id: "${CHAIN_ID}"`,
        "payments_in:", // missing credits_topup
      ].join("\n")
    );
    useTmpRoot(tmpDir);

    try {
      const { getPaymentConfig } = await loadPaymentConfig();
      expect(() => getPaymentConfig()).toThrow(/Invalid repo-spec structure/i);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

/** Minimal valid base YAML for governance tests (cogni_dao + payments_in required by schema) */
const BASE_YAML = [
  `node_id: "${TEST_NODE_ID}"`,
  "cogni_dao:",
  `  chain_id: "${CHAIN_ID}"`,
  "payments_in:",
  "  credits_topup:",
  "    provider: cogni-usdc-backend-v1",
  '    receiving_address: "0x1111111111111111111111111111111111111111"',
].join("\n");

async function loadRepoSpecModule(): Promise<RepoSpecModule> {
  vi.resetModules();
  return import("@/shared/config/repoSpec.server");
}

describe("getGovernanceConfig (repo-spec)", () => {
  it("returns schedules when governance section is provided", async () => {
    const yaml = [
      BASE_YAML,
      "governance:",
      "  schedules:",
      "    - charter: COMMUNITY",
      '      cron: "0 */6 * * *"',
      "      timezone: UTC",
      "      entrypoint: COMMUNITY",
      "    - charter: GOVERN",
      '      cron: "0 * * * *"',
      "      timezone: UTC",
      "      entrypoint: GOVERN",
    ].join("\n");

    const tmpDir = writeRepoSpec(yaml);
    useTmpRoot(tmpDir);

    try {
      const { getGovernanceConfig } = await loadRepoSpecModule();
      const config = getGovernanceConfig();

      expect(config.schedules).toHaveLength(2);
      expect(config.schedules[0]).toEqual({
        charter: "COMMUNITY",
        cron: "0 */6 * * *",
        timezone: "UTC",
        entrypoint: "COMMUNITY",
      });
      expect(config.schedules[1]).toEqual({
        charter: "GOVERN",
        cron: "0 * * * *",
        timezone: "UTC",
        entrypoint: "GOVERN",
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns empty schedules when governance section is omitted", async () => {
    const tmpDir = writeRepoSpec(BASE_YAML);
    useTmpRoot(tmpDir);

    try {
      const { getGovernanceConfig } = await loadRepoSpecModule();
      const config = getGovernanceConfig();

      expect(config.schedules).toEqual([]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("defaults timezone to UTC when omitted", async () => {
    const yaml = [
      BASE_YAML,
      "governance:",
      "  schedules:",
      "    - charter: ENGINEERING",
      '      cron: "0 */4 * * *"',
      "      entrypoint: ENGINEERING",
    ].join("\n");

    const tmpDir = writeRepoSpec(yaml);
    useTmpRoot(tmpDir);

    try {
      const { getGovernanceConfig } = await loadRepoSpecModule();
      const config = getGovernanceConfig();

      expect(config.schedules[0]?.timezone).toBe("UTC");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects schedule with empty charter", async () => {
    const yaml = [
      BASE_YAML,
      "governance:",
      "  schedules:",
      '    - charter: ""',
      '      cron: "0 * * * *"',
      "      entrypoint: GOVERN",
    ].join("\n");

    const tmpDir = writeRepoSpec(yaml);
    useTmpRoot(tmpDir);

    try {
      const { getGovernanceConfig } = await loadRepoSpecModule();
      expect(() => getGovernanceConfig()).toThrow(
        /Invalid repo-spec structure/i
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("rejects schedule with cron too short", async () => {
    const yaml = [
      BASE_YAML,
      "governance:",
      "  schedules:",
      "    - charter: GOVERN",
      '      cron: "* *"',
      "      entrypoint: GOVERN",
    ].join("\n");

    const tmpDir = writeRepoSpec(yaml);
    useTmpRoot(tmpDir);

    try {
      const { getGovernanceConfig } = await loadRepoSpecModule();
      expect(() => getGovernanceConfig()).toThrow(
        /Invalid repo-spec structure/i
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
