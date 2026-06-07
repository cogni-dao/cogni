// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { BASE_VALID_ENV } from "@tests/_fixtures/env/base-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ORIGINAL_ENV = process.env;

describe("node-template agent discovery", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV, ...BASE_VALID_ENV };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("does not advertise operator lifecycle graphs", async () => {
    const { listAgentsForApi } = await import("@/bootstrap/agent-discovery");

    const graphIds = listAgentsForApi().map((agent) => agent.graphId);

    expect(graphIds).not.toContain("langgraph:pr-manager");
    expect(graphIds).not.toContain("langgraph:operating-review");
    expect(graphIds).not.toContain("langgraph:git-reviewer");
    expect(graphIds).toContain("langgraph:pr-review");
  });
});
