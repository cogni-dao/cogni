// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/secrets/platform-services.parity.spec`
 * Purpose: Hold the operator image's platform-service mirror in lockstep with the three
 *   substrate declarations of the same boundary — the catalog loader's `PLATFORM_SERVICES`,
 *   the bash mirror in `reconcile-secrets.sh`, and the owner-node default in
 *   `secret-materialize.sh`. The operator image ships no `scripts/` tree, so nothing but
 *   this test stops the app's copy from drifting.
 * Scope: Reads the three script files as text and compares them to the app constants.
 *   Asserts nothing about OpenBao, OpenFGA, or route behaviour.
 * Invariants:
 *   - ONE_ALLOWLIST: a bucket the route will accept must be one the catalog loader
 *     accepts as a `service:` and the materializer mints. A name present here but absent
 *     there is a write to a path nothing provisions; the reverse is a provisioned bucket
 *     the sanctioned write path cannot reach.
 *   - OWNER_NODE_MATCHES_THE_MINTING_LEG: the node whose `can_manage_secrets` administers
 *     these buckets is the node that already mints them, not a second choice made here.
 * Side-effects: IO (reads scripts/lib, scripts/setup/lib, scripts/ci at test time)
 * Links: src/shared/secrets/platform-services.data.ts, scripts/lib/secrets-catalog-loader.ts
 * @public
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  PLATFORM_SERVICE_OWNER_NODE,
  PLATFORM_SERVICES,
} from "@/shared/secrets/platform-services.data";

/** Walk up to the repo root so the test survives being moved. */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "scripts/lib/secrets-catalog-loader.ts"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("repo root not found above the test file");
}

const read = (relative: string): string =>
  readFileSync(join(repoRoot(), relative), "utf8");

function loaderServices(): string[] {
  const block =
    /PLATFORM_SERVICES:\s*ReadonlySet<string>\s*=\s*new Set(?:<string>)?\(\[([^\]]*)\]\)/.exec(
      read("scripts/lib/secrets-catalog-loader.ts")
    );
  expect(
    block,
    "PLATFORM_SERVICES must exist in the catalog loader"
  ).not.toBeNull();
  return [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)]
    .map((match) => match[1] as string)
    .sort();
}

function bashServices(): string[] {
  const block = /declare -ga PLATFORM_SERVICES=\(([\s\S]*?)\)/.exec(
    read("scripts/setup/lib/reconcile-secrets.sh")
  );
  expect(
    block,
    "PLATFORM_SERVICES must exist in the bash mirror"
  ).not.toBeNull();
  return (block?.[1] ?? "")
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter(Boolean)
    .sort();
}

describe("platform-service boundary parity", () => {
  it("reads a non-empty allowlist from the catalog loader", () => {
    // Guards the guard: a regex that stopped matching would make parity vacuous.
    expect(loaderServices().length).toBeGreaterThan(0);
  });

  it("mirrors the catalog loader and the bash declaration exactly", () => {
    const app = [...PLATFORM_SERVICES].sort();
    expect(app).toEqual(loaderServices());
    expect(app).toEqual(bashServices());
  });

  it("names the same owner node the materializer mints these buckets on", () => {
    const owner =
      /PLATFORM_SERVICE_OWNER_NODE="\$\{PLATFORM_SERVICE_OWNER_NODE:-([a-z0-9-]+)\}"/.exec(
        read("scripts/ci/secret-materialize.sh")
      );
    expect(
      owner,
      "secret-materialize.sh must declare an owner node"
    ).not.toBeNull();
    expect(PLATFORM_SERVICE_OWNER_NODE).toBe(owner?.[1]);
  });
});
