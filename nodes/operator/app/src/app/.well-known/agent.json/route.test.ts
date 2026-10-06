// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BUILD_SHA: "test-sha" }),
}));

vi.mock("@/shared/config/repoSpec.server", () => ({
  getNodeBrandColor: () => "#000000",
  getNodeBrandIcon: () => "circle",
  getNodeHook: () => "Test hook",
  getNodeMission: () => "Test mission",
  getNodeName: () => "Test node",
  getNodeThumbnail: () => null,
}));

describe("GET /.well-known/agent.json", () => {
  it("publishes the candidate-flight action from the typed wire contract", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://0.0.0.0:3000/.well-known/agent.json", {
        headers: {
          "x-forwarded-host": "operator.example",
          "x-forwarded-proto": "https",
        },
      })
    );
    const body = await response.json();

    expect(body.endpoints.openapi).toBe(
      "https://operator.example/openapi.json"
    );
    expect(body.actions.flightCandidate).toMatchObject({
      method: "POST",
      endpoint: "https://operator.example/api/v1/vcs/flight",
      auth: { type: "bearer", capability: "node.flight" },
      inputSchema: {
        type: "object",
        required: ["nodeRef"],
        properties: {
          nodeRef: {
            type: "object",
            required: ["nodeId", "sourceSha"],
          },
        },
      },
      outputSchema: {
        type: "object",
        required: ["dispatched", "slot", "nodeRef", "workflowUrl", "message"],
      },
    });
  });

  // `endpoints.workItems` is only a URL — it cannot tell an agent the route takes
  // POST, what body it wants, or that the server allocates the id. Agents without
  // these schemas fall back to harness-local slash commands, which hardcode the
  // operator apex and so file every node's work onto operator. Project the
  // schemas from the zod contracts so they cannot drift from the handlers.
  it("publishes the work-item write actions from the typed wire contracts", async () => {
    const { GET } = await import("./route");
    const response = await GET(
      new Request("http://0.0.0.0:3000/.well-known/agent.json", {
        headers: {
          "x-forwarded-host": "poly.example",
          "x-forwarded-proto": "https",
        },
      })
    );
    const body = await response.json();

    // Origin-derived, so a node advertises its OWN hub as the write target.
    expect(body.actions.createWorkItem).toMatchObject({
      method: "POST",
      endpoint: "https://poly.example/api/v1/work/items",
      auth: { type: "bearer" },
      inputSchema: {
        type: "object",
        required: ["type", "title"],
      },
    });
    expect(
      body.actions.createWorkItem.inputSchema.properties.type.enum
    ).toEqual(["task", "bug", "story", "spike", "subtask"]);

    expect(body.actions.updateWorkItem).toMatchObject({
      method: "PATCH",
      endpoint: "https://poly.example/api/v1/work/items/{id}",
      auth: { type: "bearer" },
    });
    // The wrapper is `set`, not `patch` — the single most misfiled detail
    // (bug.5242 was misdiagnosed as drift because of it).
    expect(body.actions.updateWorkItem.inputSchema.properties).toHaveProperty(
      "set"
    );

    // Creating is a first-class step of the loop, not an undocumented aside.
    expect(body.process.requiredLoop).toContain("adopt_or_create_work_item");
  });
});
