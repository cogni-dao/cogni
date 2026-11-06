// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/mesh-policy.test`
 * Purpose: Prove the env Headscale policy is exactly the derivation of the resolver output (task.5429,
 *   HR 3 and 4): explicit deny base, `tag:substrate` always owned by the env owner, one TCP rule per node
 *   to its own substrate ports only, no node-to-node rule, no non-substrate port, and a stable text that
 *   reads back equal.
 * Scope: Pure functions only. Does not touch Headscale.
 * Invariants: the serialized text equals the literal the adapter contract test writes to headscale:v0.29.7.
 * Side-effects: none
 * Links: mesh-policy.ts, tests/component/node-deploy/headscale.adapter.int.test.ts
 */

import { describe, expect, it } from "vitest";

import { headscaleUser } from "@/ports";

import {
  denyAllPolicy,
  deriveMeshPolicy,
  MeshPolicyError,
  meshOwner,
  nodeTag,
  policyMatches,
  policyNodeTags,
  portsForTypes,
  SUBSTRATE_PORTS,
  serializeMeshPolicy,
} from "./mesh-policy";

const NODE_A = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const NODE_B = "0b9d3c2e-1111-4222-8333-944455556666";
const OWNER = headscaleUser("cogni-mesh-contract");

describe("deriveMeshPolicy", () => {
  it("deny-all seed: an explicit empty acls array and the tag:substrate owner (HR 4)", () => {
    const seed = denyAllPolicy(OWNER);
    expect(seed).toEqual({
      tagOwners: { "tag:substrate": ["cogni-mesh-contract@"] },
      acls: [],
    });
    // `{}` or a policy without `acls`/`grants` is allow-all in Headscale v0.29.7; the seed never is.
    expect(JSON.parse(serializeMeshPolicy(seed))).toHaveProperty("acls", []);
  });

  it("one TCP rule per node to exactly its resolver ports; no node is ever a destination (HR 3)", () => {
    const doc = deriveMeshPolicy({
      owner: OWNER,
      grants: [
        { nodeId: NODE_A, ports: [5432] },
        {
          nodeId: NODE_B,
          ports: portsForTypes(["doltgres", "redis", "ai-gateway", "temporal"]),
        },
      ],
    });
    expect(doc.acls).toEqual([
      {
        action: "accept",
        proto: "tcp",
        src: [`tag:node-${NODE_B}`],
        dst: ["tag:substrate:4000,5435,6379,7233"],
      },
      {
        action: "accept",
        proto: "tcp",
        src: [`tag:node-${NODE_A}`],
        dst: ["tag:substrate:5432"],
      },
    ]);
    for (const rule of doc.acls) {
      expect(rule.dst.every((d) => d.startsWith("tag:substrate:"))).toBe(true);
      expect(rule.src.every((s) => s.startsWith("tag:node-"))).toBe(true);
    }
    expect(doc.tagOwners["tag:substrate"]).toEqual(["cogni-mesh-contract@"]);
    // Node tags exist (so their keys are valid) but no user owns them.
    expect(doc.tagOwners[`tag:node-${NODE_A}`]).toEqual([]);
    expect(doc.tagOwners[`tag:node-${NODE_B}`]).toEqual([]);
  });

  it("serializes to the exact text the adapter contract test writes to a real Headscale", () => {
    const doc = deriveMeshPolicy({
      owner: OWNER,
      grants: [
        { nodeId: NODE_A, ports: [5432] },
        { nodeId: NODE_B, ports: [7233, 4000, 6379, 5435] },
      ],
    });
    expect(serializeMeshPolicy(doc)).toBe(
      `{"acls":[{"action":"accept","dst":["tag:substrate:4000,5435,6379,7233"],"proto":"tcp","src":["tag:node-${NODE_B}"]},{"action":"accept","dst":["tag:substrate:5432"],"proto":"tcp","src":["tag:node-${NODE_A}"]}],"tagOwners":{"tag:node-${NODE_B}":[],"tag:node-${NODE_A}":[],"tag:substrate":["cogni-mesh-contract@"]}}`
    );
    expect(serializeMeshPolicy(denyAllPolicy(OWNER))).toBe(
      `{"acls":[],"tagOwners":{"tag:substrate":["cogni-mesh-contract@"]}}`
    );
  });

  it("is order-independent and unions a node's workloads", () => {
    const a = deriveMeshPolicy({
      owner: OWNER,
      grants: [
        { nodeId: NODE_A, ports: [6379] },
        { nodeId: NODE_B, ports: [5435] },
        { nodeId: NODE_A, ports: [4000, 6379] },
      ],
    });
    const b = deriveMeshPolicy({
      owner: OWNER,
      grants: [
        { nodeId: NODE_B, ports: [5435] },
        { nodeId: NODE_A, ports: [4000] },
        { nodeId: NODE_A, ports: [6379] },
      ],
    });
    expect(serializeMeshPolicy(a)).toBe(serializeMeshPolicy(b));
    expect(a.acls.find((r) => r.src[0] === `tag:node-${NODE_A}`)?.dst).toEqual([
      "tag:substrate:4000,6379",
    ]);
  });

  it("a node with no substrate ports gets its tag and no rule (deny)", () => {
    const doc = deriveMeshPolicy({
      owner: OWNER,
      grants: [{ nodeId: NODE_A, ports: [] }],
    });
    expect(doc.acls).toEqual([]);
    expect(policyNodeTags(doc)).toEqual(new Set([`tag:node-${NODE_A}`]));
  });

  it("refuses a port outside the service-type registry, so no other VM port reaches the tailnet (HR 3)", () => {
    for (const port of [22, 30900, 8080, 5433])
      expect(() =>
        deriveMeshPolicy({
          owner: OWNER,
          grants: [{ nodeId: NODE_A, ports: [port] }],
        })
      ).toThrow(MeshPolicyError);
    expect(Object.values(SUBSTRATE_PORTS).sort()).toEqual([
      4000, 5432, 5435, 6379, 7233,
    ]);
  });

  it("refuses a node id that is not a valid lowercase tag name", () => {
    expect(() => nodeTag("Node_A")).toThrow(MeshPolicyError);
    expect(() => nodeTag("")).toThrow(MeshPolicyError);
    expect(nodeTag(NODE_A)).toBe(`tag:node-${NODE_A}`);
    expect(meshOwner("candidate-a")).toBe("cogni-mesh-candidate-a");
  });
});

describe("policyMatches", () => {
  const derived = deriveMeshPolicy({
    owner: OWNER,
    grants: [{ nodeId: NODE_A, ports: [5432] }],
  });

  it("matches its own serialization and the same JSON with different key order", () => {
    expect(policyMatches(serializeMeshPolicy(derived), derived)).toBe(true);
    const reordered = JSON.stringify(
      { tagOwners: derived.tagOwners, acls: derived.acls },
      null,
      2
    );
    expect(policyMatches(reordered, derived)).toBe(true);
  });

  it("rejects absent, allow-all, hand-edited, widened and unparsable policies (HR 4)", () => {
    expect(policyMatches(null, derived)).toBe(false);
    expect(policyMatches("", derived)).toBe(false);
    expect(policyMatches("{}", derived)).toBe(false);
    expect(
      policyMatches(serializeMeshPolicy(denyAllPolicy(OWNER)), derived)
    ).toBe(false);
    const widened = JSON.parse(serializeMeshPolicy(derived));
    widened.acls[0].dst = ["tag:substrate:*"];
    expect(policyMatches(JSON.stringify(widened), derived)).toBe(false);
    const nodeToNode = JSON.parse(serializeMeshPolicy(derived));
    nodeToNode.acls.push({
      action: "accept",
      proto: "tcp",
      src: ["tag:node-x"],
      dst: [`tag:node-${NODE_A}:*`],
    });
    expect(policyMatches(JSON.stringify(nodeToNode), derived)).toBe(false);
    expect(
      policyMatches(`// comment\n${serializeMeshPolicy(derived)}`, derived)
    ).toBe(false);
  });
});
