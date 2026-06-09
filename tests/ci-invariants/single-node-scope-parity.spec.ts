// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/single-node-scope-parity`
 * Purpose: Asserts the reference single-node-scope classifier matches every fixture's expected outcome.
 * Scope: Pure-data fixture replay backed by a reference classifier. Does NOT invoke the GitHub Action or shell out to git.
 * Invariants: POLICY_PARITY_WITH_0382, RIDE_ALONG, SINGLE_DOMAIN_HARD_FAIL.
 * Side-effects: IO (reads fixture JSON)
 * Notes: Fixtures are the shared source of truth. When task.0382 imports
 *        `classify` (or implements its equivalent), it should run against
 *        the same fixtures and the it.todo cases below should be filled in.
 * Links: tests/ci-invariants/classify.ts, work/items/task.0382.*
 * @public
 */

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { extractOwningNode, type OwningNode } from "@cogni/repo-spec";
import { buildTestRepoSpec } from "@cogni/repo-spec/testing";
import { describe, expect, it } from "vitest";
import { type ClassifyResult, classify } from "./classify";

const FIXTURES_DIR = path.join(__dirname, "fixtures/single-node-scope");
const OPERATOR_NODE = "operator";
const LEGACY_FIXTURE_NODES = ["legacy-alpha", "legacy-beta"] as const;

interface Fixture {
  name: string;
  paths: string[];
  expected: ClassifyResult;
}

function loadFixtures(): Array<{ file: string; data: Fixture }> {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((file) => ({
      file,
      data: JSON.parse(
        readFileSync(path.join(FIXTURES_DIR, file), "utf8")
      ) as Fixture,
    }));
}

/** Deterministic test UUID per registry slot (format mirrors `TEST_NODE_IDS`). */
function testNodeId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

/**
 * Synthetic legacy registry for policy fixtures.
 *
 * The structural meta test covers today's real `nodes/*` filters. These
 * fixtures intentionally avoid real node names because in-tree node source
 * directories are transitional; the policy under test is "legacy in-tree node
 * domain" behavior, not canary/resy as architecture.
 */
function fixtureRegistry(): Array<{
  node_id: string;
  node_name: string;
  path: string;
}> {
  return [OPERATOR_NODE, ...LEGACY_FIXTURE_NODES].map((name, i) => ({
    node_id: testNodeId(i),
    node_name: name,
    path: `nodes/${name}`,
  }));
}

describe("single-node-scope · CI gate side (reference classifier)", () => {
  const fixtures = loadFixtures();
  const nodes = [...LEGACY_FIXTURE_NODES];

  expect(fixtures.length, "at least one fixture must exist").toBeGreaterThan(0);

  for (const { file, data } of fixtures) {
    it(`${file}: ${data.name}`, () => {
      const result = classify(data.paths, nodes);
      expect(result).toEqual(data.expected);
    });
  }
});

/**
 * Translate `OwningNode` → `ClassifyResult`. The bash gate speaks domain *names*
 * (`"legacy-alpha"`, `"operator"`); the resolver speaks `nodeId` UUIDs.
 * Domain name is the second segment of the registry entry's `path`
 * (`nodes/legacy-alpha` → `"legacy-alpha"`).
 */
function toClassifyResult(o: OwningNode): ClassifyResult {
  if (o.kind === "miss") {
    return { domains: [], pass: true, rideAlongApplied: false };
  }
  if (o.kind === "single") {
    const name = o.path.split("/")[1] ?? "";
    return {
      domains: [name],
      pass: true,
      rideAlongApplied: o.rideAlongApplied === true,
    };
  }
  const names = o.nodes.map((n) => n.path.split("/")[1] ?? "").sort();
  return { domains: names, pass: false, rideAlongApplied: false };
}

describe("single-node-scope · runtime resolver side (task.0382)", () => {
  const fixtures = loadFixtures();

  const spec = buildTestRepoSpec({ nodes: fixtureRegistry() });

  for (const { file, data } of fixtures) {
    it(`${file}: ${data.name}`, () => {
      const result = toClassifyResult(extractOwningNode(spec, data.paths));
      expect(result).toEqual(data.expected);
    });
  }
});
