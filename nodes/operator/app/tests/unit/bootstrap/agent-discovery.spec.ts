// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("operator agent discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...BASE_VALID_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("advertises operator lifecycle graphs", async () => {
    const { listAgentsForApi } = await import("@/bootstrap/agent-discovery");

    const graphIds = listAgentsForApi().map((agent) => agent.graphId);

    expect(graphIds).toContain("langgraph:pr-manager");
    expect(graphIds).toContain("langgraph:operating-review");
    expect(graphIds).toContain("langgraph:git-reviewer");
  });
});
