// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/secrets/node-secrets-reserved.parity.spec`
 * Purpose: Keep `SUBSTRATE_RESERVED_KEYS` in lockstep with the secrets catalog's
 *   agent-generated entries. The two expressions of that rule live in different
 *   runtimes — `scripts/ci/secret-materialize.sh` reads the catalog, this guard
 *   ships in an operator image that does NOT carry it — so until the set is
 *   codegen'd (#1479 typed-module pattern) nothing but this test holds them together.
 * Scope: Parses the operator-domain catalog and compares it to the denylist.
 *   Asserts nothing about node-domain catalogs or about OpenBao itself.
 * Invariants:
 *   - AGENT_GENERATED_IS_RESERVED: every catalog key the materializer would mint
 *     (`source: agent` + non-shared + a random `generate.kind`) must be denied to
 *     self-serve. Such a key is minted once and never re-derivable, so a
 *     self-serve write does not fail loudly — it destroys whatever the old value
 *     protected. That drift is what let a self-serve write clobber
 *     `CONNECTIONS_ENCRYPTION_KEY` on prod beacon.
 * Side-effects: IO (reads infra/secrets-catalog.yaml at test time)
 * Links: src/shared/secrets/node-secrets-reserved.data.ts, scripts/ci/secret-materialize.sh
 * @public
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { SUBSTRATE_RESERVED_KEYS } from "@/shared/secrets/node-secrets-reserved.data";

/** Mirrors `key_is_agent_generated()` in scripts/ci/secret-materialize.sh. */
const RANDOM_GENERATE_KINDS = new Set(["base64", "hex", "sk-cogni"]);

/** Walk up to the repo root so the test survives being moved. */
function catalogPath(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "infra/secrets-catalog.yaml");
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error("infra/secrets-catalog.yaml not found above the test file");
}

interface CatalogEntry {
  name?: string;
  source?: string;
  service?: string;
  shared?: boolean;
  generate?: { kind?: string };
}

function agentGeneratedCatalogKeys(): string[] {
  const catalog = parse(readFileSync(catalogPath(), "utf8")) as {
    secrets?: CatalogEntry[];
  };

  return (catalog.secrets ?? [])
    .filter(
      (entry) =>
        entry.source === "agent" &&
        entry.service !== "_shared" &&
        entry.shared !== true &&
        RANDOM_GENERATE_KINDS.has(entry.generate?.kind ?? "")
    )
    .map((entry) => entry.name)
    .filter((name): name is string => Boolean(name));
}

describe("SUBSTRATE_RESERVED_KEYS ↔ secrets catalog parity", () => {
  it("reads a non-trivial catalog", () => {
    // Guards the guard: a bad path or schema drift would otherwise make the
    // parity assertion below vacuously true.
    expect(agentGeneratedCatalogKeys().length).toBeGreaterThan(3);
  });

  it("denies self-serve writes to every agent-generated catalog key", () => {
    const missing = agentGeneratedCatalogKeys().filter(
      (key) => !SUBSTRATE_RESERVED_KEYS.has(key)
    );

    // A key here means the catalog gained an agent-minted secret without the
    // operator image learning it is substrate-owned. Add it to
    // SUBSTRATE_RESERVED_KEYS — do not relax this test.
    expect(missing).toEqual([]);
  });
});
