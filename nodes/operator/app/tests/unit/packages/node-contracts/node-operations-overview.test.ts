// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Contract coverage for the display-safe node operations response. */

import { nodeOperationsOverviewOperation } from "@cogni/node-contracts";
import { describe, expect, it } from "vitest";

describe("nodes.operations-overview.v1", () => {
  it("accepts independent unavailable modules and strips undeclared infrastructure fields", () => {
    const parsed = nodeOperationsOverviewOperation.output.parse({
      nodes: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "alpha",
          title: "Alpha",
          icon: null,
          thumbnailUrl: null,
          brandColor: null,
          formationStatus: "active",
          relationship: "owner",
          detailUrl: "/nodes/11111111-1111-4111-8111-111111111111",
          manageUrl: "/must-not-leak",
          providerConsumerAccountId: "must-not-leak",
          modules: {
            deployment: {
              state: "available",
              status: "healthy",
              homepageUrl: null,
              environments: [
                {
                  env: "candidate-a",
                  label: "Test",
                  declared: true,
                  health: "healthy",
                  sourceSha: null,
                  buildSha: "abc123",
                  replicas: { desired: 1, ready: 1 },
                  services: {
                    state: "available",
                    items: [
                      {
                        name: "app",
                        visibility: "public",
                        image: "must-not-leak",
                        secretRefs: ["must-not-leak"],
                      },
                    ],
                  },
                  compute: {
                    state: "unavailable",
                    resourceId: "must-not-leak",
                  },
                },
              ],
            },
            governance: { state: "unavailable" },
          },
        },
      ],
    });

    expect(parsed.nodes[0]).not.toHaveProperty("providerConsumerAccountId");
    expect(parsed.nodes[0]).not.toHaveProperty("manageUrl");
    expect(
      parsed.nodes[0]?.modules.deployment.state === "available"
        ? parsed.nodes[0].modules.deployment.environments[0]?.services
        : null
    ).toEqual({
      state: "available",
      items: [{ name: "app", visibility: "public" }],
    });
    expect(
      parsed.nodes[0]?.modules.deployment.state === "available"
        ? parsed.nodes[0].modules.deployment.environments[0]?.compute
        : null
    ).toEqual({ state: "unavailable" });
  });
});
