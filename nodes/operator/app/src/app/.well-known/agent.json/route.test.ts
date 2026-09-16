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
});
