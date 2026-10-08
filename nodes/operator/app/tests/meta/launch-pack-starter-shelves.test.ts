// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/meta/launch-pack-starter-shelves`
 * Purpose: CI enforcement for STARTER_SHELVES_MIRROR_BASE_DOMAIN_SEEDS — the
 *   starter-shelf ids the node launch pack tells a first agent to register must
 *   equal `BASE_DOMAIN_SEEDS` in `packages/knowledge-base/src/seeds/domains.ts`.
 * Scope: Reads the seed source file and compares id sets. Does NOT test runtime behavior.
 * Invariants: The seed file is the source of truth; the launch pack mirrors it as prompt
 *   text because the operator app does not depend on `@cogni/knowledge-base`. The
 *   knowledge `domains` registry is append-only (POST, no DELETE), so a drifted list
 *   permanently pollutes every node spawned while it was wrong.
 * Side-effects: IO (file system reads)
 * Notes: Runs in CI as part of `pnpm check`. If this fails, update
 *   `NODE_STARTER_SHELF_IDS` — never the other way round.
 * Links: src/features/nodes/launch-pack.ts, packages/knowledge-base/src/seeds/domains.ts,
 *   knowledge entry `cogni-domain-taxonomy`, task.5196
 * @public
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { NODE_STARTER_SHELF_IDS } from "@/features/nodes/launch-pack";

const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(APP_ROOT, "../../..");
const DOMAIN_SEEDS_FILE = join(
  REPO_ROOT,
  "packages/knowledge-base/src/seeds/domains.ts"
);

/**
 * Extract the `id:` literals from the BASE_DOMAIN_SEEDS array body. Parsing the
 * source instead of importing it keeps the operator app free of a dependency on
 * `@cogni/knowledge-base` (a drizzle schema package) for what is prompt text.
 */
function readBaseDomainSeedIds(): string[] {
  const source = readFileSync(DOMAIN_SEEDS_FILE, "utf8");
  const start = source.indexOf("export const BASE_DOMAIN_SEEDS");
  expect(start).toBeGreaterThan(-1);
  const body = source.slice(start);
  const end = body.indexOf("\n];");
  expect(end).toBeGreaterThan(-1);
  return [...body.slice(0, end).matchAll(/^\s*id:\s*"([^"]+)"/gm)].flatMap(
    (match) => (match[1] ? [match[1]] : [])
  );
}

describe("launch-pack starter shelves", () => {
  it("mirrors BASE_DOMAIN_SEEDS exactly, in order", () => {
    expect([...NODE_STARTER_SHELF_IDS]).toEqual(readBaseDomainSeedIds());
  });

  it("only uses the approved use-*/build-* or bare-noun shelf shapes", () => {
    const allowedBareNouns = new Set(["meta", "mission", "strategy", "method"]);
    for (const id of NODE_STARTER_SHELF_IDS) {
      const shaped =
        id.startsWith("use-") || id.startsWith("build-")
          ? true
          : allowedBareNouns.has(id);
      expect(shaped, `unexpected shelf id shape: ${id}`).toBe(true);
    }
  });
});
