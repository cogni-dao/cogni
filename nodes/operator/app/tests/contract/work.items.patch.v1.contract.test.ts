// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/work.items.patch.v1.contract`
 * Purpose: Validates Zod schema for work items patch contract — allowlist coverage,
 *   strict-object rejection of unknown keys, and the empty-set refinement.
 * Scope: Pure Zod schema validation. Does not test HTTP transport or DB.
 * Invariants:
 *   - PATCH_ALLOWLIST_COVERS_DEPLOY_VERIFIED: deployVerified, projectId, parentId,
 *     blockedBy round-trip through the schema (bug.5005).
 *   - STRICT_REJECTS_UNKNOWN: unknown keys 400 with the bad key surfaced — no
 *     silent stripping that triggers the misleading `set must contain at least one
 *     field` error.
 *   - EMPTY_SET_REFINEMENT: `set: {}` still returns the empty-set message.
 * Side-effects: none
 * Links: bug.5005, packages/node-contracts/src/work.items.patch.v1.contract.ts
 * @internal
 */

import { workItemsPatchOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("workItemsPatchOperation.input", () => {
  it("accepts deployVerified:true", () => {
    const result = workItemsPatchOperation.input.safeParse({
      id: "bug.5005",
      set: { deployVerified: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.set.deployVerified).toBe(true);
    }
  });

  it("accepts projectId:null (clearing the field)", () => {
    const result = workItemsPatchOperation.input.safeParse({
      id: "task.5005",
      set: { projectId: null },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.set.projectId).toBeNull();
    }
  });

  it("accepts parentId and blockedBy as nullable strings", () => {
    expect(
      workItemsPatchOperation.input.safeParse({
        id: "task.5005",
        set: { parentId: "task.5004", blockedBy: null },
      }).success
    ).toBe(true);
  });

  it("rejects unknown keys with the bad key surfaced in issues[]", () => {
    const result = workItemsPatchOperation.input.safeParse({
      id: "bug.5005",
      set: { garbage: 1 },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issues = result.error.issues;
      const mentioned = issues.some((iss) =>
        JSON.stringify(iss).includes("garbage")
      );
      expect(mentioned).toBe(true);
    }
  });

  it("rejects a wrong top-level wrapper key ({patch}) and surfaces it (bug.5242)", () => {
    // Guessing `{ patch: {...} }` from the operation name is the recurring
    // misdiagnosis. The strict top-level wrapper must name the bad key AND flag
    // the missing `set`, so the 400 tells the caller how to fix it.
    const result = workItemsPatchOperation.input.safeParse({
      id: "bug.5242",
      patch: { status: "needs_closeout" },
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const blob = JSON.stringify(result.error.issues);
      expect(blob).toContain("patch");
      const paths = result.error.issues.flatMap((i) => i.path);
      expect(paths).toContain("set");
    }
  });

  it("rejects an empty set with the empty-set message", () => {
    const result = workItemsPatchOperation.input.safeParse({
      id: "bug.5005",
      set: {},
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message);
      expect(messages).toContain("set must contain at least one field");
    }
  });

  it("preserves the existing whitelist (title, status, branch, ...)", () => {
    const result = workItemsPatchOperation.input.safeParse({
      id: "bug.5005",
      set: {
        title: "renamed",
        status: "needs_closeout",
        branch: "derekg1729/x",
        pr: "https://github.com/x/y/pull/1",
      },
    });
    expect(result.success).toBe(true);
  });
});
