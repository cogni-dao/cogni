// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/db-client/tests/client-options`
 * Purpose: Verify injected pool configuration without opening a connection.
 * Scope: Factory option forwarding only. Does not test database semantics.
 * Invariants: Defaults and role-specific DSNs remain unchanged.
 * Side-effects: none
 * Links: bug.5467
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { postgres, drizzle } = vi.hoisted(() => ({
  postgres: vi.fn(() => ({ pool: true })),
  drizzle: vi.fn((client: unknown) => ({ $client: client })),
}));

vi.mock("postgres", () => ({ default: postgres }));
vi.mock("drizzle-orm/postgres-js", () => ({ drizzle }));

import { createAppDbClient } from "../src/client";
import { createServiceDbClient } from "../src/service";

describe("injected database pool options", () => {
  beforeEach(() => vi.clearAllMocks());

  it("preserves default pools and role-specific names", () => {
    createAppDbClient("postgres://app@example/db");
    createServiceDbClient("postgres://service@example/db");
    expect(postgres.mock.calls).toEqual([
      [
        "postgres://app@example/db",
        {
          max: 10,
          idle_timeout: 20,
          connect_timeout: 10,
          connection: { application_name: "cogni_template_app" },
        },
      ],
      [
        "postgres://service@example/db",
        {
          max: 10,
          idle_timeout: 20,
          connect_timeout: 10,
          connection: { application_name: "cogni_service" },
        },
      ],
    ]);
  });

  it.each([
    createAppDbClient,
    createServiceDbClient,
  ])("forwards bounded pools without replacing the injected DSN", (factory) => {
    const db = factory("postgres://scoped@example/db", {
      max: 1,
      applicationName: "bounded_consumer",
    });
    expect(postgres).toHaveBeenCalledWith(
      "postgres://scoped@example/db",
      expect.objectContaining({
        max: 1,
        connection: { application_name: "bounded_consumer" },
      })
    );
    expect(db.$client).toEqual({ pool: true });
  });

  it.each([
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("rejects invalid pool maximum %s before constructing a client", (max) => {
    expect(() =>
      createAppDbClient("postgres://scoped@example/db", { max })
    ).toThrow("Database pool max must be a positive safe integer");
    expect(postgres).not.toHaveBeenCalled();
  });
});
