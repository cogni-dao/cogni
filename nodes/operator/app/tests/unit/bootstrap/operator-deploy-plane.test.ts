// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";

const constructedConfigs: unknown[] = [];

vi.mock("@/adapters/server", () => ({
  GitHubRepoWriter: class MockGitHubRepoWriter {
    constructor(config: unknown) {
      constructedConfigs.push(config);
    }
  },
}));

import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import type { ServerEnv } from "@/shared/env";

function makeEnv(overrides: Partial<ServerEnv> = {}): ServerEnv {
  return {
    GH_REVIEW_APP_ID: "1",
    GH_REVIEW_APP_PRIVATE_KEY_BASE64:
      Buffer.from("private-key").toString("base64"),
    ...overrides,
  } as ServerEnv;
}

describe("createOperatorDeployPlane", () => {
  it("passes GHCR deploy credentials when configured", () => {
    constructedConfigs.length = 0;

    createOperatorDeployPlane(
      makeEnv({
        GHCR_DEPLOY_USERNAME: "deploy-user",
        GHCR_DEPLOY_TOKEN: "deploy-token",
      })
    );

    expect(constructedConfigs[0]).toMatchObject({
      appId: "1",
      privateKey: "private-key",
      ghcrDeployCredentials: {
        username: "deploy-user",
        token: "deploy-token",
      },
    });
  });

  it("defaults GHCR username to the deploy bot when only token is configured", () => {
    constructedConfigs.length = 0;

    createOperatorDeployPlane(
      makeEnv({
        GHCR_DEPLOY_TOKEN: "deploy-token",
      })
    );

    expect(constructedConfigs[0]).toMatchObject({
      ghcrDeployCredentials: {
        username: "Cogni-1729",
        token: "deploy-token",
      },
    });
  });
});
