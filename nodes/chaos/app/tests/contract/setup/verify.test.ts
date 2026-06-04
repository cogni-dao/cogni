// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/setup/verify`
 * Purpose: Contract tests for DAO formation verification endpoint.
 * Scope: Tests /api/setup/verify security boundary and validation logic; does not make real RPC calls.
 * Invariants: Server NEVER trusts client-supplied addresses; only txHashes accepted.
 * Side-effects: none
 * Links: src/app/api/setup/verify/route.ts
 * @public
 */

import { setupVerifyOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("setupVerifyOperation contract", () => {
  describe("input validation", () => {
    it("accepts valid BASE chainId (8453)", () => {
      const result = setupVerifyOperation.input.safeParse({
        chainId: 8453,
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
      });

      expect(result.success).toBe(true);
    });

    it("accepts valid SEPOLIA chainId (11155111)", () => {
      const result = setupVerifyOperation.input.safeParse({
        chainId: 11155111,
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
      });

      expect(result.success).toBe(true);
    });

    it("rejects unsupported chainId (Ethereum mainnet)", () => {
      const result = setupVerifyOperation.input.safeParse({
        chainId: 1, // Ethereum mainnet - not supported
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("8453");
      }
    });

    it("rejects unsupported chainId (Base Sepolia)", () => {
      const result = setupVerifyOperation.input.safeParse({
        chainId: 84532, // Base Sepolia - not in SUPPORTED_CHAIN_IDS
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
      });

      expect(result.success).toBe(false);
    });

    it("rejects invalid tx hash format", () => {
      const result = setupVerifyOperation.input.safeParse({
        chainId: 8453,
        daoTxHash: "0xinvalid",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("Invalid tx hash");
      }
    });

    it("rejects invalid address format", () => {
      const result = setupVerifyOperation.input.safeParse({
        chainId: 8453,
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0xinvalid",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toContain("Invalid address");
      }
    });

    it("rejects missing signalBlockNumber", () => {
      const result = setupVerifyOperation.input.safeParse({
        chainId: 8453,
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        initialHolder: "0x1234567890123456789012345678901234567890",
      });

      expect(result.success).toBe(false);
    });

    it("SECURITY: rejects request with client-supplied daoAddress field", () => {
      const malicious = {
        chainId: 8453,
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
        daoAddress: "0xMALICIOUS0000000000000000000000000000000", // MUST be rejected
      };

      const result = setupVerifyOperation.input.safeParse(malicious);

      // .strict() on zod schema ensures unknown keys are rejected
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      }
    });

    it("SECURITY: rejects request with client-supplied pluginAddress field", () => {
      const malicious = {
        chainId: 8453,
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
        pluginAddress: "0xMALICIOUS0000000000000000000000000000000",
      };

      const result = setupVerifyOperation.input.safeParse(malicious);
      expect(result.success).toBe(false);
    });

    it("SECURITY: rejects request with client-supplied signalAddress field", () => {
      const malicious = {
        chainId: 8453,
        daoTxHash:
          "0x1234567890123456789012345678901234567890123456789012345678901234",
        signalTxHash:
          "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        signalBlockNumber: 12345678,
        initialHolder: "0x1234567890123456789012345678901234567890",
        signalAddress: "0xMALICIOUS0000000000000000000000000000000",
      };

      const result = setupVerifyOperation.input.safeParse(malicious);
      expect(result.success).toBe(false);
    });
  });

  describe("output validation", () => {
    it("validates successful verification response structure", () => {
      const success = {
        verified: true as const,
        addresses: {
          dao: "0x1234567890123456789012345678901234567890",
          token: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
          plugin: "0x9876543210987654321098765432109876543210",
          signal: "0xfedcbafedcbafedcbafedcbafedcbafedcbafedc",
        },
        repoSpecYaml: 'cogni_dao:\n  chain_id: "8453"\n',
      };

      const result = setupVerifyOperation.output.safeParse(success);
      if (!result.success) {
        // Debug: log actual errors
        console.log(
          "Validation failed:",
          JSON.stringify(result.error.format(), null, 2)
        );
      }
      expect(result.success).toBe(true);
    });

    it("validates failure response structure", () => {
      const failure = {
        verified: false as const,
        errors: ["DAORegistered event not found", "Transaction reverted"],
      };

      const result = setupVerifyOperation.output.safeParse(failure);
      expect(result.success).toBe(true);
    });
  });
});
