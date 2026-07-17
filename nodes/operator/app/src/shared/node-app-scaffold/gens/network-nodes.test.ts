// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { insertNetworkNode } from "./network-nodes";

const ROSTER = `export const NETWORK_NODES: readonly NetworkNode[] = [
  {
    name: "operator",
    nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
    primary: true,
  },
  { name: "beacon", nodeId: "f97f68f2-8406-4a3b-b5a9-d579b779f19d" },
];
`;

describe("insertNetworkNode", () => {
  it("splices a new entry in before the array close, preserving existing entries", () => {
    const out = insertNetworkNode(
      ROSTER,
      "floop",
      "2c7374e5-1111-2222-3333-444455556666"
    );
    expect(out).toContain(
      `  { name: "floop", nodeId: "2c7374e5-1111-2222-3333-444455556666" },\n];`
    );
    // existing entries untouched
    expect(out).toContain(`name: "operator"`);
    expect(out).toContain(`{ name: "beacon",`);
    // valid single array close, entry sits INSIDE it
    expect(out.indexOf("floop")).toBeLessThan(out.indexOf("\n];"));
  });

  it("is byte-stable: the only change is the inserted line", () => {
    const out = insertNetworkNode(ROSTER, "floop", "abc");
    expect(out.replace(`  { name: "floop", nodeId: "abc" },\n`, "")).toBe(
      ROSTER
    );
  });

  it("throws when the node is already in the roster (never double-insert)", () => {
    expect(() => insertNetworkNode(ROSTER, "beacon", "x")).toThrow(
      /already contains/
    );
  });

  it("throws when the NETWORK_NODES array is absent", () => {
    expect(() =>
      insertNetworkNode("export const OTHER = [];\n", "floop", "x")
    ).toThrow(/missing the NETWORK_NODES array opener/);
  });
});
