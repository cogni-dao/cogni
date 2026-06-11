// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  countSubmoduleNodes,
  evaluateNodeCapacity,
} from "@/features/nodes/capacity";

const GITMODULES = `[submodule "nodes/oss"]
	path = nodes/oss
	url = https://github.com/cogni-test-org/oss.git
[submodule "nodes/blue"]
	path = nodes/blue
	url = https://github.com/cogni-test-org/blue.git
[submodule "nodes/please"]
	path = nodes/please
	url = https://github.com/cogni-test-org/please.git
`;

describe("countSubmoduleNodes", () => {
  it("counts nodes/<slug> submodule gitlinks", () => {
    expect(countSubmoduleNodes(GITMODULES)).toBe(3);
  });

  it("returns 0 for a missing/empty .gitmodules (empty network)", () => {
    expect(countSubmoduleNodes(null)).toBe(0);
    expect(countSubmoduleNodes("")).toBe(0);
  });

  it("ignores non-node submodules and url lines", () => {
    const mixed = `[submodule "vendor/lib"]
	path = vendor/lib
	url = https://example.com/lib.git
[submodule "nodes/solo"]
	path = nodes/solo
	url = https://example.com/solo.git
`;
    expect(countSubmoduleNodes(mixed)).toBe(1);
  });
});

describe("evaluateNodeCapacity", () => {
  it("allows a birth strictly below the ceiling", () => {
    const d = evaluateNodeCapacity({ deployedNodeCount: 7, ceiling: 8 });
    expect(d.allowed).toBe(true);
    expect(d.deployedNodeCount).toBe(7);
    expect(d.ceiling).toBe(8);
  });

  it("blocks at the ceiling (the hand-back boundary)", () => {
    const d = evaluateNodeCapacity({ deployedNodeCount: 8, ceiling: 8 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/capacity/i);
  });

  it("blocks over the ceiling", () => {
    expect(
      evaluateNodeCapacity({ deployedNodeCount: 12, ceiling: 8 }).allowed
    ).toBe(false);
  });
});
