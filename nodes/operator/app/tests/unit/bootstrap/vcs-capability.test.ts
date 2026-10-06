// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/vcs-capability`
 * Purpose: Pin graceful degradation for the operator-only recovery capability.
 * Scope: Stub behavior only; no GitHub or environment IO.
 * Side-effects: none
 * Links: task.5188
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  createVcsCapability,
  stubVcsCapability,
} from "@/bootstrap/capabilities/vcs";

describe("stubVcsCapability", () => {
  it("wires recovery on both configured and unconfigured capabilities", () => {
    const unconfigured = createVcsCapability({} as never);
    const configured = createVcsCapability({
      GH_REVIEW_APP_ID: "1",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64:
        Buffer.from("test-key").toString("base64"),
    } as never);

    expect(unconfigured).toBe(stubVcsCapability);
    expect(unconfigured.recoverOperatorChange).toEqual(expect.any(Function));
    expect(configured).not.toBe(stubVcsCapability);
    expect(configured.recoverOperatorChange).toEqual(expect.any(Function));
  });

  it("fails operator change recovery explicitly when GitHub is unconfigured", async () => {
    await expect(
      stubVcsCapability.recoverOperatorChange({
        owner: "cogni-test-org",
        repo: "cogni-monorepo",
        prNumber: 68,
        signedBaseSha: "b".repeat(40),
        losingHeadSha: "a".repeat(40),
        intent: {
          operation: "env.membership",
          node: "spawny-boi",
          environment: "candidate-a",
          action: "add",
          leaseGeneration: 0,
          recoveryRootSha: "a".repeat(40),
          recoveryDepth: 0,
        },
      })
    ).rejects.toThrow("Operator change recovery not configured");
  });
});
