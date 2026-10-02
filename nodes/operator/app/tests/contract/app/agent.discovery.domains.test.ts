// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/contract/app/agent.discovery.domains`
 * Purpose: Pin machine discovery for the node-local domain control plane.
 * Scope: Directly exercises the public agent.json handler with mocked identity/config.
 * Invariants: MACHINE_DISCOVERABLE_DOMAIN_CONTROL_PLANE, NO_INTERNAL_BIND_ADDR.
 * Side-effects: none
 * Links: nodes/operator/app/src/app/.well-known/agent.json/route.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import { GET } from "@/app/.well-known/agent.json/route";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "abc123" }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeName: () => "operator",
  getNodeHook: () => "Operator hook",
  getNodeMission: () => "Operator mission",
  getNodeBrandIcon: () => "network",
  getNodeBrandColor: () => "#000000",
  getNodeThumbnail: () => null,
}));

describe("agent.json knowledge-domain discovery", () => {
  it("advertises node-relative list/create/delete actions and schemas", async () => {
    const response = await GET(
      new Request("http://0.0.0.0:3000/.well-known/agent.json", {
        headers: {
          "x-forwarded-host": "node.example",
          "x-forwarded-proto": "https",
        },
      })
    );
    const body = await response.json();

    expect(body.endpoints.knowledgeDomains).toBe(
      "https://node.example/api/v1/knowledge/domains"
    );
    expect(body.actions.listKnowledgeDomains).toMatchObject({
      method: "GET",
      endpoint: "https://node.example/api/v1/knowledge/domains",
      auth: { type: "bearer-or-session" },
    });
    expect(body.actions.createKnowledgeDomain.inputSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining(["id", "name"]),
    });
    expect(body.actions.deleteKnowledgeDomain).toMatchObject({
      method: "DELETE",
      endpoint: "https://node.example/api/v1/knowledge/domains/{id}",
      auth: { type: "bearer-or-session" },
    });
    expect(body.actions.deleteKnowledgeDomain.conflictSchema).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "error",
        "domain",
        "entryCount",
        "referenceCount",
      ]),
    });
  });
});
