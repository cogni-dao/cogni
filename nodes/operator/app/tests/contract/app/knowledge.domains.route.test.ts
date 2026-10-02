// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/knowledge.domains.route`
 * Purpose: Route-level contract tests for domain list/create/guarded-delete.
 * Scope: Uses next-test-api-route-handler with mocked identity and knowledge port.
 * Invariants: DOMAIN_AUTHENTICATED_CONTROL_PLANE, DOMAIN_DELETE_EMPTY_ONLY.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/api/v1/knowledge/domains
 * @internal
 */

import { DomainInUseError } from "@cogni/knowledge-store";
import { TEST_SESSION_USER_1 } from "@tests/_fakes/ids";
import { testApiHandler } from "next-test-api-route-handler";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as session from "@/app/_lib/auth/session";
import * as deleteHandler from "@/app/api/v1/knowledge/domains/[id]/route";
import * as collectionHandler from "@/app/api/v1/knowledge/domains/route";

const domain = {
  id: "operator",
  name: "Operator",
  description: "Operator knowledge",
  confidencePct: 40,
  entryCount: 68,
  createdAt: "2026-10-02T00:00:00.000Z",
};
const mocks = vi.hoisted(() => ({
  listDomainsFull: vi.fn(),
  registerDomain: vi.fn(),
  deleteDomain: vi.fn(),
}));

vi.mock("@/bootstrap/container", () => {
  const log = {
    child: vi.fn(() => log),
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  };
  return {
    getContainer: vi.fn(() => ({
      log,
      clock: { now: vi.fn(() => new Date("2026-10-02T00:00:00Z")) },
      config: { unhandledErrorPolicy: "rethrow" },
      knowledgeStorePort: {
        listDomainsFull: mocks.listDomainsFull,
        registerDomain: mocks.registerDomain,
        deleteDomain: mocks.deleteDomain,
      },
    })),
  };
});

vi.mock("@/app/_lib/auth/session", () => ({
  getSessionUser: vi.fn().mockResolvedValue(TEST_SESSION_USER_1),
}));

describe("knowledge domains authenticated control plane", () => {
  beforeEach(() => {
    mocks.listDomainsFull.mockReset().mockResolvedValue([domain]);
    mocks.registerDomain.mockReset().mockResolvedValue({
      ...domain,
      id: "temporary",
      name: "Temporary",
      description: null,
      entryCount: 0,
    });
    mocks.deleteDomain.mockReset();
    vi.mocked(session.getSessionUser).mockResolvedValue(TEST_SESSION_USER_1);
  });

  it("allows a Bearer-authenticated principal to list domains", async () => {
    await testApiHandler({
      appHandler: collectionHandler,
      url: "/api/v1/knowledge/domains",
      async test({ fetch }) {
        const response = await fetch({
          method: "GET",
          headers: { authorization: "Bearer cogni_ag_sk_v1_test" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ domains: [domain] });
      },
    });
  });

  it("keeps create available to the same Bearer principal", async () => {
    await testApiHandler({
      appHandler: collectionHandler,
      url: "/api/v1/knowledge/domains",
      async test({ fetch }) {
        const response = await fetch({
          method: "POST",
          headers: {
            authorization: "Bearer cogni_ag_sk_v1_test",
            "content-type": "application/json",
          },
          body: JSON.stringify({ id: "temporary", name: "Temporary" }),
        });
        expect(response.status).toBe(201);
        expect((await response.json()).id).toBe("temporary");
      },
    });
  });

  it("returns a typed 409 while domain usage remains", async () => {
    mocks.deleteDomain.mockRejectedValue(
      new DomainInUseError("operator", 68, 12)
    );
    await testApiHandler({
      appHandler: deleteHandler,
      params: { id: "operator" },
      async test({ fetch }) {
        const response = await fetch({
          method: "DELETE",
          headers: { authorization: "Bearer cogni_ag_sk_v1_test" },
        });
        expect(response.status).toBe(409);
        expect(await response.json()).toEqual({
          error: "domain_in_use",
          domain: "operator",
          entryCount: 68,
          referenceCount: 12,
        });
      },
    });
  });

  it("deletes an empty domain and returns the typed receipt", async () => {
    mocks.deleteDomain.mockResolvedValue(true);
    await testApiHandler({
      appHandler: deleteHandler,
      params: { id: "temporary" },
      async test({ fetch }) {
        const response = await fetch({
          method: "DELETE",
          headers: { authorization: "Bearer cogni_ag_sk_v1_test" },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          id: "temporary",
          deleted: true,
        });
      },
    });
  });
});
