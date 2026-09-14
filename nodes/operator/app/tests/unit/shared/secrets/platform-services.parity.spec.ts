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
  INHERITED_KEY_OWNER,
  SUBSTRATE_RESERVED_KEYS,
} from "@/shared/secrets/node-secrets-reserved.data";
import {
  PLATFORM_SERVICE_OWNED_KEYS,
  PLATFORM_SERVICE_OWNER_NODE,
  PLATFORM_SERVICES,
} from "@/shared/secrets/platform-services.data";

/**
 * Walk the catalog once, yielding `{ name, service, inheritFrom }` per entry. The operator
 * image ships no catalog, so every app-side mirror of a catalog fact is pinned from here.
 */
function catalogEntries(): {
  name: string;
  service?: string;
  inheritFrom?: string;
}[] {
  const entries: { name: string; service?: string; inheritFrom?: string }[] =
    [];
  for (const line of read("infra/secrets-catalog.yaml").split("\n")) {
    const name = /^ {2}- name:\s*(\S+)/.exec(line);
    if (name) {
      entries.push({ name: name[1] as string });
      continue;
    }
    const current = entries.at(-1);
    if (!current) continue;
    const service = /^ {4}service:\s*(\S+)/.exec(line);
    if (service) current.service = service[1] as string;
    const inheritFrom = /^ {4}inheritFrom:\s*(\S+)/.exec(line);
    if (inheritFrom) current.inheritFrom = inheritFrom[1] as string;
  }
  return entries;
}

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

describe("key↔service binding parity", () => {
  it("reads a non-empty catalog", () => {
    // Guards the guard: a broken scan would make both assertions below vacuous.
    expect(catalogEntries().length).toBeGreaterThan(0);
  });

  it("binds exactly the keys the catalog declares under a platform service", () => {
    // A key the catalog puts in a platform-service bucket but the app does not bind is a
    // key that can still be misfiled into a node bucket — the wallet-exposure incident.
    const fromCatalog = catalogEntries()
      .filter(
        (e) => e.service !== undefined && PLATFORM_SERVICES.has(e.service)
      )
      .map((e) => `${e.name}=${e.service}`)
      .sort();
    const fromApp = [...PLATFORM_SERVICE_OWNED_KEYS]
      .map(([key, service]) => `${key}=${service}`)
      .sort();
    expect(fromApp).toEqual(fromCatalog);
  });
});

describe("bug.5016 — overwrite-on-drift keys bind to their canonical owner", () => {
  it("maps every catalog inheritFrom key to exactly the owner the catalog names", () => {
    // `inheritFrom` makes secret-materialize.sh overwrite-on-drift for that key, so a
    // self-serve write from a NON-owner node returns 200 and is silently reverted on the
    // next flight. The binding must stay exact in both directions: a missing key
    // re-opens the silent-revert hole, and a wrong owner would refuse the one write that
    // actually persists. Reading the catalog directly is what stops either from drifting.
    const fromCatalog = catalogEntries()
      .filter((e) => e.inheritFrom !== undefined)
      .map((e) => `${e.name}=${e.inheritFrom}`)
      .sort();
    const fromApp = [...INHERITED_KEY_OWNER]
      .map(([key, owner]) => `${key}=${owner}`)
      .sort();
    expect(fromCatalog.length).toBeGreaterThan(0);
    expect(fromApp).toEqual(fromCatalog);
  });

  it("does not blanket-reserve inherited keys, so the owner can still rotate them", () => {
    // The regression this guards: reserving OPENROUTER_API_KEY outright would break the
    // documented clean rotation path (openrouter-api-key-expert), because writing it at
    // `operator` IS the rotation — that bucket is the source the fan-out reads.
    // GH_WEBHOOK_SECRET is the deliberate exception: source: agent AND dual-plane.
    const blanketReserved = [...INHERITED_KEY_OWNER.keys()].filter((key) =>
      SUBSTRATE_RESERVED_KEYS.has(key)
    );
    expect(blanketReserved).toEqual(["GH_WEBHOOK_SECRET"]);
  });
});
