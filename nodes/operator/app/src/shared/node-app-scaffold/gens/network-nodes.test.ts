// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { insertNetworkNode } from "./network-nodes";

describe("insertNetworkNode", () => {
  const current = `export const NETWORK_NODES = [
  { name: "operator", nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d", primary: true },
  { name: "red", nodeId: "895147d5-2ad9-4b2b-aeaa-f2669999fdce" },
];
`;

  it("appends a node roster entry before the array terminator", () => {
    expect(
      insertNetworkNode(current, "poly", "4b06359a-a859-4399-888e-a8c7a6696f7e")
    ).toContain(
      `  { name: "poly", nodeId: "4b06359a-a859-4399-888e-a8c7a6696f7e" },\n];`
    );
  });

  it("is idempotent for an existing node with the same id", () => {
    const once = insertNetworkNode(
      current,
      "poly",
      "4b06359a-a859-4399-888e-a8c7a6696f7e"
    );
    expect(
      insertNetworkNode(once, "poly", "4b06359a-a859-4399-888e-a8c7a6696f7e")
    ).toBe(once);
  });

  it("fails closed when a slug already exists with a different id", () => {
    expect(() =>
      insertNetworkNode(current, "red", "4b06359a-a859-4399-888e-a8c7a6696f7e")
    ).toThrow(/red already exists with nodeId/);
  });
});
