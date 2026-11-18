// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-registry/node-admin-sync.test`
 * Purpose: Pin the node-admin sync decision core: add, remove, empty, unmapped, unavailable, zero-admin refused.
 * Scope: Pure unit test over `planNodeAdminSync` / `planAdminDiff` / `userIdFromSubject`. No IO.
 * Invariants: NEVER_DELETE_ON_DOUBT, NEVER_ZERO_ADMINS, DIFF_ONLY, SUBJECTS_ARE_USERS.
 * Side-effects: none
 * Links: src/shared/node-registry/node-admin-sync.ts, task.5494
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  planAdminDiff,
  planNodeAdminSync,
  userIdFromSubject,
} from "./node-admin-sync";

const read = (userIds: string[], approverCount = userIds.length) =>
  ({ status: "read", approverCount, userIds }) as const;

describe("planNodeAdminSync", () => {
  it("adds an approver who is not yet an admin", () => {
    expect(
      planNodeAdminSync({
        approvers: read(["a", "b"]),
        currentUserIds: ["a"],
      })
    ).toEqual({ outcome: "ok", adds: ["b"], deletes: [] });
  });

  it("removes an admin who is no longer an approver, in the same diff as an add", () => {
    expect(
      planNodeAdminSync({
        approvers: read(["b"]),
        currentUserIds: ["a"],
      })
    ).toEqual({ outcome: "ok", adds: ["b"], deletes: ["a"] });
  });

  it("plans nothing when the sets already match", () => {
    expect(
      planNodeAdminSync({
        approvers: read(["a", "b"]),
        currentUserIds: ["b", "a"],
      })
    ).toEqual({ outcome: "ok", adds: [], deletes: [] });
  });

  it("is empty when the approver list is empty or malformed, and never deletes", () => {
    expect(
      planNodeAdminSync({
        approvers: read([], 0),
        currentUserIds: ["a"],
      })
    ).toEqual({ outcome: "empty", adds: [], deletes: [] });
  });

  it("is empty when approvers exist but none maps to a user, and never deletes", () => {
    expect(
      planNodeAdminSync({
        approvers: read([], 2),
        currentUserIds: ["a"],
      })
    ).toEqual({ outcome: "empty", adds: [], deletes: [] });
  });

  it("is unavailable when the repo-spec read failed", () => {
    expect(
      planNodeAdminSync({
        approvers: { status: "unavailable" },
        currentUserIds: ["a"],
      })
    ).toEqual({ outcome: "unavailable", adds: [], deletes: [] });
  });

  it("is unavailable when the current tuples could not be read", () => {
    expect(
      planNodeAdminSync({
        approvers: read(["a"]),
        currentUserIds: null,
      })
    ).toEqual({ outcome: "unavailable", adds: [], deletes: [] });
  });

  it("deduplicates mapped user ids", () => {
    expect(
      planNodeAdminSync({
        approvers: read(["a", "a"], 2),
        currentUserIds: [],
      })
    ).toEqual({ outcome: "ok", adds: ["a"], deletes: [] });
  });
});

describe("planAdminDiff", () => {
  it("refuses a diff that would leave zero admins", () => {
    expect(planAdminDiff(["a", "b"], [])).toEqual({
      outcome: "refused",
      adds: [],
      deletes: [],
    });
  });

  it("allows a full replacement because the adds keep someone an admin", () => {
    expect(planAdminDiff(["a"], ["b"])).toEqual({
      outcome: "ok",
      adds: ["b"],
      deletes: ["a"],
    });
  });
});

describe("userIdFromSubject", () => {
  it("manages only plain user subjects", () => {
    expect(userIdFromSubject("user:abc")).toBe("abc");
    expect(userIdFromSubject("user:*")).toBeNull();
    expect(userIdFromSubject("user:")).toBeNull();
    expect(userIdFromSubject("team:abc#member")).toBeNull();
    expect(userIdFromSubject("user:abc#member")).toBeNull();
  });
});
