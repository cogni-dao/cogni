// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { assertComputeCostAppRoleDatabaseUrl } from "./compute-cost-database-url";

function captureError(input: string): unknown {
  try {
    assertComputeCostAppRoleDatabaseUrl(input);
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("assertComputeCostAppRoleDatabaseUrl", () => {
  it("accepts a dedicated non-superuser app role", () => {
    expect(() =>
      assertComputeCostAppRoleDatabaseUrl(
        "postgresql://app_operator:secret@postgres.example/operator"
      )
    ).not.toThrow();
  });

  it.each([
    "postgres",
    "root",
    "admin",
    "superuser",
    "app_service",
    "service_worker",
  ])("rejects forbidden role %s without echoing the DSN", (username) => {
    const error = captureError(
      `postgresql://${username}:never-log-this@postgres.example/operator`
    );
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain("never-log-this");
    expect(error).not.toHaveProperty("input");
    expect(error).not.toHaveProperty("cause");
  });

  it("redacts malformed URL parser input and decode failures", () => {
    for (const dsn of [
      "not-a-url:never-log-this",
      "postgresql://bad%zz:never-log-this@postgres.example/operator",
    ]) {
      const error = captureError(dsn);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("never-log-this");
      expect(error).not.toHaveProperty("input");
      expect(error).not.toHaveProperty("cause");
    }
  });
});
