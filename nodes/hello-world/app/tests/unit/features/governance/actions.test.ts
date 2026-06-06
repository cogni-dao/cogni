// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/governance/actions`
 * Purpose: Unit tests for governance action registry and handler input validation.
 * Scope: Tests resolveAction registry and handler validation paths. GitHub API calls are not tested (requires mocks).
 * Invariants: Action key = `${action}:${target}`. Invalid input returns validation_failed result.
 * Side-effects: none
 * Links: src/features/governance/actions.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  grantCollaborator,
  mergeChange,
  resolveAction,
  revokeCollaborator,
} from "@/features/governance/actions";
import type { Signal } from "@/features/governance/signal-types";

// Minimal logger mock
const mockLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => mockLog,
} as never;

function makeSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    dao: "0x1234567890abcdef1234567890abcdef12345678",
    chainId: BigInt(8453),
    vcs: "github",
    repoUrl: "https://github.com/cogni-dao/cogni",
    action: "merge",
    target: "change",
    resource: "42",
    nonce: BigInt(1),
    deadline: Math.floor(Date.now() / 1000) + 3600,
    paramsJson: "",
    executor: "0xabcdef1234567890abcdef1234567890abcdef12",
    ...overrides,
  };
}

describe("features/governance/actions", () => {
  describe("resolveAction", () => {
    it("resolves merge:change", () => {
      expect(resolveAction("merge", "change")).toBe(mergeChange);
    });

    it("resolves grant:collaborator", () => {
      expect(resolveAction("grant", "collaborator")).toBe(grantCollaborator);
    });

    it("resolves revoke:collaborator", () => {
      expect(resolveAction("revoke", "collaborator")).toBe(revokeCollaborator);
    });

    it("returns undefined for unknown action", () => {
      expect(resolveAction("delete", "repo")).toBeUndefined();
    });
  });

  describe("mergeChange validation", () => {
    it("rejects non-integer PR number", async () => {
      const signal = makeSignal({ resource: "not-a-number" });
      const result = await mergeChange(
        signal,
        { host: "github.com", owner: "org", repo: "repo", url: "" },
        {} as never,
        mockLog
      );
      expect(result.success).toBe(false);
      expect(result.action).toBe("validation_failed");
    });

    it("rejects zero PR number", async () => {
      const signal = makeSignal({ resource: "0" });
      const result = await mergeChange(
        signal,
        { host: "github.com", owner: "org", repo: "repo", url: "" },
        {} as never,
        mockLog
      );
      expect(result.success).toBe(false);
    });
  });

  describe("grantCollaborator validation", () => {
    it("rejects empty username", async () => {
      const signal = makeSignal({
        action: "grant",
        target: "collaborator",
        resource: "",
      });
      const result = await grantCollaborator(
        signal,
        { host: "github.com", owner: "org", repo: "repo", url: "" },
        {} as never,
        mockLog
      );
      expect(result.success).toBe(false);
      expect(result.action).toBe("validation_failed");
    });

    it("rejects username with invalid characters", async () => {
      const signal = makeSignal({
        action: "grant",
        target: "collaborator",
        resource: "user name!",
      });
      const result = await grantCollaborator(
        signal,
        { host: "github.com", owner: "org", repo: "repo", url: "" },
        {} as never,
        mockLog
      );
      expect(result.success).toBe(false);
    });
  });

  describe("revokeCollaborator validation", () => {
    it("rejects invalid username", async () => {
      const signal = makeSignal({
        action: "revoke",
        target: "collaborator",
        resource: "../traversal",
      });
      const result = await revokeCollaborator(
        signal,
        { host: "github.com", owner: "org", repo: "repo", url: "" },
        {} as never,
        mockLog
      );
      expect(result.success).toBe(false);
      expect(result.action).toBe("validation_failed");
    });
  });
});
