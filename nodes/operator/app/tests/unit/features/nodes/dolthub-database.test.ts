// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/dolthub-database`
 * Purpose: Unit tests for the Cogni-owned DoltHub database bootstrap client.
 * Scope: Mocked fetch only; no live DoltHub calls.
 * Side-effects: process global fetch stub.
 * Links: src/features/nodes/dolthub-database.ts
 * @internal
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { createDoltHubDatabaseEnsurer } from "@/features/nodes/dolthub-database";

const INPUT = {
  owner: "cogni-dao-test",
  repo: "knowledge-my-node",
  description: "Cogni node my-node knowledge mirror",
};

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("createDoltHubDatabaseEnsurer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates the DoltHub database with Cogni's PAT", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: "Success" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createDoltHubDatabaseEnsurer({
      DOLTHUB_API_TOKEN: "secret-token",
    }).ensureDatabase(INPUT);

    expect(result).toEqual({
      owner: "cogni-dao-test",
      repo: "knowledge-my-node",
      created: true,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.dolthub.com/api/v1alpha1/database",
      {
        method: "POST",
        headers: {
          authorization: "token secret-token",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          ownerName: "cogni-dao-test",
          repoName: "knowledge-my-node",
          description: "Cogni node my-node knowledge mirror",
          visibility: "public",
        }),
      }
    );
  });

  it("treats an existing database response as idempotent success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse(
          { status: "Error: database already exists" },
          { status: 400 }
        )
      )
    );

    await expect(
      createDoltHubDatabaseEnsurer({
        DOLTHUB_API_TOKEN: "secret-token",
      }).ensureDatabase(INPUT)
    ).resolves.toEqual({
      owner: "cogni-dao-test",
      repo: "knowledge-my-node",
      created: false,
    });
  });

  it("fails closed when the PAT is absent", () => {
    expect(() =>
      createDoltHubDatabaseEnsurer({ DOLTHUB_API_TOKEN: undefined })
    ).toThrow(/DOLTHUB_API_TOKEN required/);
  });

  it("does not leak the PAT in thrown DoltHub errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ message: "unauthorized" }, { status: 401 })
      )
    );

    await expect(
      createDoltHubDatabaseEnsurer({
        DOLTHUB_API_TOKEN: "secret-token",
      }).ensureDatabase(INPUT)
    ).rejects.toThrow(/DoltHub database create failed: unauthorized/);
  });
});
