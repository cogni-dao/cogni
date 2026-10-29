// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
import { describe, expect, it } from "vitest";
import { classifyGithubOpError } from "@/features/vcs/github-op-error";

describe("GitHub operation failure classification", () => {
  it("preserves the actionable Actions execution restriction", () => {
    const error = Object.assign(
      new Error("Actions has been disabled for this repository."),
      { status: 422 }
    );
    expect(classifyGithubOpError(error).error).toContain(
      "fork reactivation prompt"
    );
    expect(classifyGithubOpError(error).error).not.toContain("Support");
    expect(classifyGithubOpError(error)).toMatchObject({
      status: 422,
      errorCode: "actions_disabled",
    });
  });
  it("does not misclassify an unrelated validation failure", () => {
    expect(
      classifyGithubOpError(
        Object.assign(new Error("Validation failed"), { status: 422 })
      ).errorCode
    ).toBe("github_op_failed");
  });
});
