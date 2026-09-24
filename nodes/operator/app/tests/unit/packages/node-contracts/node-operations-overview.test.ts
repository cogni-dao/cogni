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
            deployment: { state: "unavailable" },
            services: {
              state: "available",
              environment: "candidate-a",
              items: [
                {
                  name: "app",
                  visibility: "public",
                  image: "must-not-leak",
                  secretRefs: ["must-not-leak"],
                },
              ],
            },
            compute: { state: "unavailable", resourceId: "must-not-leak" },
            governance: { state: "unavailable" },
          },
        },
      ],
    });

    expect(parsed.nodes[0]).not.toHaveProperty("providerConsumerAccountId");
    expect(parsed.nodes[0]).not.toHaveProperty("manageUrl");
    expect(parsed.nodes[0]?.modules.services).toEqual({
      state: "available",
      environment: "candidate-a",
      items: [{ name: "app", visibility: "public" }],
    });
    expect(parsed.nodes[0]?.modules.compute).toEqual({ state: "unavailable" });
  });
});
