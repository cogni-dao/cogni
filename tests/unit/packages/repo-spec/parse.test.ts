// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/packages/repo-spec/parse`
 * Purpose: Unit tests for parseRepoSpec() — valid YAML, invalid YAML, missing fields, extra fields.
 * Scope: Pure function tests. Does not perform disk I/O.
 * Invariants: parseRepoSpec accepts string or object, validates with Zod, returns typed result.
 * Side-effects: none
 * Links: packages/repo-spec/src/parse.ts
 * @public
 */

import { parseRepoSpec } from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";

const TEST_NODE_ID = "00000000-0000-4000-8000-000000000001";
const TEST_SCOPE_ID = "00000000-0000-4000-8000-000000000002";

/** Minimal valid YAML for parse tests */
const VALID_YAML = [
  `node_id: "${TEST_NODE_ID}"`,
  "cogni_dao:",
  '  chain_id: "8453"',
  "payments_in:",
  "  credits_topup:",
  "    provider: cogni-usdc-backend-v1",
  '    receiving_address: "0x1111111111111111111111111111111111111111"',
].join("\n");

/** Minimal valid object for parse tests */
const VALID_OBJECT = {
  node_id: TEST_NODE_ID,
  cogni_dao: { chain_id: "8453" },
  payments_in: {
    credits_topup: {
      provider: "cogni-usdc-backend-v1",
      receiving_address: "0x1111111111111111111111111111111111111111",
    },
  },
};

describe("parseRepoSpec", () => {
  describe("string input (YAML)", () => {
    it("parses valid YAML string", () => {
      const result = parseRepoSpec(VALID_YAML);
      expect(result.node_id).toBe(TEST_NODE_ID);
      expect(result.cogni_dao.chain_id).toBe("8453");
      expect(result.payments_in.credits_topup.provider).toBe(
        "cogni-usdc-backend-v1"
      );
    });

    it("applies Zod defaults (governance.schedules = [])", () => {
      const result = parseRepoSpec(VALID_YAML);
      expect(result.governance).toEqual({ schedules: [] });
    });

    it("throws on invalid YAML syntax", () => {
      expect(() => parseRepoSpec("{{not: valid: yaml")).toThrow(
        /Failed to parse YAML/
      );
    });

    it("throws on empty string", () => {
      expect(() => parseRepoSpec("")).toThrow(/Invalid repo-spec structure/);
    });
  });

  describe("object input (pre-parsed)", () => {
    it("parses valid pre-parsed object", () => {
      const result = parseRepoSpec(VALID_OBJECT);
      expect(result.node_id).toBe(TEST_NODE_ID);
    });

    it("throws on empty object", () => {
      expect(() => parseRepoSpec({})).toThrow(/Invalid repo-spec structure/);
    });

    it("throws on null", () => {
      expect(() => parseRepoSpec(null)).toThrow(/Invalid repo-spec structure/);
    });
  });

  describe("schema validation", () => {
    it("rejects invalid node_id (not UUID)", () => {
      expect(() =>
        parseRepoSpec({ ...VALID_OBJECT, node_id: "not-a-uuid" })
      ).toThrow(/Invalid repo-spec structure/);
    });

    it("rejects missing cogni_dao", () => {
      const { cogni_dao: _, ...rest } = VALID_OBJECT;
      expect(() => parseRepoSpec(rest)).toThrow(/Invalid repo-spec structure/);
    });

    it("accepts missing payments_in (optional since payment activation)", () => {
      const { payments_in: _, ...rest } = VALID_OBJECT;
      expect(() => parseRepoSpec(rest)).not.toThrow();
    });

    it("rejects invalid receiving_address", () => {
      expect(() =>
        parseRepoSpec({
          ...VALID_OBJECT,
          payments_in: {
            credits_topup: {
              provider: "test",
              receiving_address: "not-an-address",
            },
          },
        })
      ).toThrow(/Invalid repo-spec structure/);
    });

    it("accepts chain_id as number", () => {
      const result = parseRepoSpec({
        ...VALID_OBJECT,
        cogni_dao: { chain_id: 8453 },
      });
      expect(result.cogni_dao.chain_id).toBe("8453");
    });

    it("accepts Cogni-owned DoltHub knowledge remote config", () => {
      const result = parseRepoSpec({
        ...VALID_OBJECT,
        knowledge: {
          database: "knowledge_my_node",
          remote: {
            provider: "dolthub",
            owner: "cogni-dao-test",
            repo: "knowledge-my-node",
            url: "https://doltremoteapi.dolthub.com/cogni-dao-test/knowledge-my-node",
            custody: "cogni-owned",
          },
        },
      });

      expect(result.knowledge?.database).toBe("knowledge_my_node");
      expect(result.knowledge?.remote.owner).toBe("cogni-dao-test");
    });

    it("rejects DoltHub remote URLs outside doltremoteapi.dolthub.com", () => {
      expect(() =>
        parseRepoSpec({
          ...VALID_OBJECT,
          knowledge: {
            database: "knowledge_my_node",
            remote: {
              provider: "dolthub",
              owner: "cogni-dao-test",
              repo: "knowledge-my-node",
              url: "https://www.dolthub.com/cogni-dao-test/knowledge-my-node",
              custody: "cogni-owned",
            },
          },
        })
      ).toThrow(/Invalid repo-spec structure/);
    });

    it("rejects DoltHub remote URLs with embedded credentials", () => {
      expect(() =>
        parseRepoSpec({
          ...VALID_OBJECT,
          knowledge: {
            database: "knowledge_my_node",
            remote: {
              provider: "dolthub",
              owner: "cogni-dao-test",
              repo: "knowledge-my-node",
              url: "https://token@doltremoteapi.dolthub.com/cogni-dao-test/knowledge-my-node",
              custody: "cogni-owned",
            },
          },
        })
      ).toThrow(/Invalid repo-spec structure/);
    });

    it("rejects DoltHub remote URLs whose path does not match owner and repo", () => {
      expect(() =>
        parseRepoSpec({
          ...VALID_OBJECT,
          knowledge: {
            database: "knowledge_my_node",
            remote: {
              provider: "dolthub",
              owner: "cogni-dao-test",
              repo: "knowledge-my-node",
              url: "https://doltremoteapi.dolthub.com/cogni-dao-test/knowledge-other",
              custody: "cogni-owned",
            },
          },
        })
      ).toThrow(/Invalid repo-spec structure/);
    });

    it("strips extra fields (Zod strict passthrough)", () => {
      const result = parseRepoSpec({
        ...VALID_OBJECT,
        extra_field: "should be ignored",
      });
      expect(result.node_id).toBe(TEST_NODE_ID);
    });
  });

  describe("full repo-spec with all sections", () => {
    it("parses complete spec with activity_ledger and governance", () => {
      const fullYaml = [
        `node_id: "${TEST_NODE_ID}"`,
        `scope_id: "${TEST_SCOPE_ID}"`,
        "scope_key: default",
        "activity_ledger:",
        "  epoch_length_days: 7",
        "  approvers:",
        '    - "0x070075F1389Ae1182aBac722B36CA12285d0c949"',
        "  pool_config:",
        '    base_issuance_credits: "10000"',
        "  activity_sources:",
        "    github:",
        "      attribution_pipeline: cogni-v0.0",
        '      source_refs: ["cogni-dao/cogni-template"]',
        "cogni_dao:",
        '  chain_id: "8453"',
        "payments_in:",
        "  credits_topup:",
        "    provider: cogni-usdc-backend-v1",
        '    receiving_address: "0x1111111111111111111111111111111111111111"',
        "governance:",
        "  schedules:",
        "    - charter: HEARTBEAT",
        '      cron: "0 * * * *"',
        "      timezone: UTC",
        "      entrypoint: HEARTBEAT",
      ].join("\n");

      const result = parseRepoSpec(fullYaml);

      expect(result.scope_id).toBe(TEST_SCOPE_ID);
      expect(result.scope_key).toBe("default");
      expect(result.activity_ledger?.epoch_length_days).toBe(7);
      expect(result.activity_ledger?.approvers).toHaveLength(1);
      expect(result.activity_ledger?.pool_config?.base_issuance_credits).toBe(
        "10000"
      );
      expect(result.governance?.schedules).toHaveLength(1);
      expect(result.governance?.schedules[0]?.charter).toBe("HEARTBEAT");
    });
  });
});
