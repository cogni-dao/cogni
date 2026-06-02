// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/node-app-scaffold/gens/lockfile`
 * Purpose: Pin `insertLockfileImporters` to a byte-exact before→after `pnpm-lock.yaml` case.
 * Scope: Pure unit test. The golden is the real lockfile importer section after
 *   `scaffold-node.sh zlock` + `pnpm install --lockfile-only`, trimmed at the `packages:`
 *   header (the splice never touches `packages:`/`snapshots:`), so it exercises the full
 *   importer-detection → sort → packages-boundary insertion path on real data.
 * Invariants: CLONE_ADDS_NO_PACKAGES (the three importer blocks are the entire delta);
 *   IMPORTERS_ARE_SORTED (`nodes/zlock/…` lands between `nodes/resy/…` and `packages/ai-core`).
 * Side-effects: none — reads committed fixtures only.
 * Links: src/features/node-app-scaffold/gens/lockfile, scripts/setup/scaffold-node.sh
 * @public
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { insertLockfileImporters } from "./lockfile";

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");

describe("insertLockfileImporters", () => {
  it("splices a cloned node's three importer blocks byte-exactly (golden: pnpm install)", () => {
    const before = fixture("lockfile-before.yaml");
    const after = fixture("lockfile-after-zlock.yaml");

    expect(insertLockfileImporters(before, "zlock")).toBe(after);
  });

  it("inserts the trio in sorted importer position", () => {
    const out = insertLockfileImporters(fixture("lockfile-before.yaml"), "zlock");
    const keys = out
      .split("\n")
      .filter((l) => /^  nodes\/[a-z0-9-]+\/(app|graphs|packages\/doltgres-schema):$/.test(l));

    const zlock = keys.filter((k) => k.includes("nodes/zlock/"));
    expect(zlock).toEqual([
      "  nodes/zlock/app:",
      "  nodes/zlock/graphs:",
      "  nodes/zlock/packages/doltgres-schema:",
    ]);
    // resy precedes zlock; node-template stays put — never reordered or removed.
    const flat = keys.join("\n");
    expect(flat.indexOf("nodes/resy/graphs")).toBeLessThan(flat.indexOf("nodes/zlock/app"));
    expect(flat).toContain("nodes/node-template/app");
  });

  it("adds importer blocks only — never duplicates or drops existing keys", () => {
    const before = fixture("lockfile-before.yaml");
    const out = insertLockfileImporters(before, "zlock");
    const importerCount = (s: string): number =>
      s.split("\n").filter((l) => /^  \S.*:$/.test(l)).length;

    // Exactly three new importer keys, nothing else changed in the section.
    expect(importerCount(out)).toBe(importerCount(before) + 3);
  });
});
