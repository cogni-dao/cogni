// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/env-membership`
 * Purpose: Pin the catalog `envs:` line editor — single-line edit, canonical ordering, idempotency,
 *   and the "only the envs: line changes" byte-stability invariant the catalog goldens depend on.
 * Scope: Pure unit tests.
 * Invariants: ENV_ORDER_CANONICAL, SINGLE_LINE_EDIT.
 * Side-effects: none
 * Links: src/shared/node-app-scaffold/gens/env-membership
 * @public
 */

import { describe, expect, it } from "vitest";

import {
  addCatalogEnv,
  dropCatalogEnv,
  parseCatalogEnvs,
  setCatalogEnvs,
} from "./env-membership";

// A realistic catalog row with comments + fields around the envs: line, so the single-line-edit
// invariant (every other byte preserved) is actually exercised.
const CATALOG = `name: blue
type: node
port: 3200
node_port: 31100
dockerfile: nodes/blue/app/Dockerfile
image_tag_suffix: "-blue"
migrator_tag_suffix: "-blue-migrate"
candidate_a_branch: deploy/candidate-a-blue
preview_branch: deploy/preview-blue
production_branch: deploy/production-blue
# task.5017 — per-env node-set comment that must survive verbatim.
envs: [candidate-a, preview, production]
path_prefix: nodes/blue/
`;

describe("parseCatalogEnvs", () => {
  it("reads the flow-sequence env-set in file order", () => {
    expect(parseCatalogEnvs(CATALOG)).toEqual([
      "candidate-a",
      "preview",
      "production",
    ]);
  });

  it("reads a candidate-a-only set", () => {
    expect(
      parseCatalogEnvs(CATALOG.replace(/envs:.*/, "envs: [candidate-a]"))
    ).toEqual(["candidate-a"]);
  });

  it("throws when the envs: line is missing", () => {
    expect(() => parseCatalogEnvs("name: x\ntype: node\n")).toThrow(/envs/);
  });

  it("throws on an unknown env token", () => {
    expect(() =>
      parseCatalogEnvs(
        CATALOG.replace(/envs:.*/, "envs: [candidate-a, staging]")
      )
    ).toThrow(/unknown env/);
  });
});

describe("setCatalogEnvs", () => {
  it("re-emits canonically ordered + touches ONLY the envs: line", () => {
    const next = setCatalogEnvs(CATALOG, ["production", "candidate-a"]);
    expect(next).toContain("envs: [candidate-a, production]");
    // Every other line is byte-identical (single-line edit).
    const before = CATALOG.split("\n").filter((l) => !l.startsWith("envs:"));
    const after = next.split("\n").filter((l) => !l.startsWith("envs:"));
    expect(after).toEqual(before);
  });

  it("round-trips add then drop back to the original line", () => {
    const dropped = setCatalogEnvs(
      CATALOG,
      dropCatalogEnv(parseCatalogEnvs(CATALOG), "production")
    );
    expect(dropped).toContain("envs: [candidate-a, preview]");
    const restored = setCatalogEnvs(
      dropped,
      addCatalogEnv(parseCatalogEnvs(dropped), "production")
    );
    expect(restored).toBe(CATALOG);
  });

  it("emits an empty flow-sequence `envs: []` for the empty set (ATOMIC_PER_ENV — deployed nowhere)", () => {
    const emptied = setCatalogEnvs(CATALOG, []);
    expect(emptied).toContain("envs: []");
    // Round-trips: an emptied row parses back to [] and only the envs: line changed.
    expect(parseCatalogEnvs(emptied)).toEqual([]);
    const before = CATALOG.split("\n").filter((l) => !l.startsWith("envs:"));
    const after = emptied.split("\n").filter((l) => !l.startsWith("envs:"));
    expect(after).toEqual(before);
  });

  it("accepts a candidate-a-absent subset (no candidate-a special-casing)", () => {
    const next = setCatalogEnvs(CATALOG, ["production", "preview"]);
    expect(next).toContain("envs: [preview, production]");
    expect(parseCatalogEnvs(next)).toEqual(["preview", "production"]);
  });

  it("preserves the file's trailing newline when `envs:` is the LAST line (bug.5073)", () => {
    // A real catalog row can END on the envs: line. The old `\s*$` (whose `\s` includes `\n`)
    // greedily ate the file's final newline, and the replacement has none → the verb's catalog
    // PR failed prettier's require-final-newline. The env-set edit must leave `\n` intact.
    const lastLine = "name: blue\ntype: node\nenvs: [candidate-a, preview, production]\n";
    const next = setCatalogEnvs(lastLine, ["preview", "production"]);
    expect(next).toBe("name: blue\ntype: node\nenvs: [preview, production]\n");
    expect(next.endsWith("]\n")).toBe(true);
  });
});

describe("addCatalogEnv / dropCatalogEnv", () => {
  it("addCatalogEnv folds in canonically + is idempotent", () => {
    expect(addCatalogEnv(["candidate-a"], "production")).toEqual([
      "candidate-a",
      "production",
    ]);
    expect(addCatalogEnv(["candidate-a", "production"], "production")).toEqual([
      "candidate-a",
      "production",
    ]);
  });

  it("dropCatalogEnv removes + is idempotent", () => {
    expect(
      dropCatalogEnv(["candidate-a", "preview", "production"], "preview")
    ).toEqual(["candidate-a", "production"]);
    expect(dropCatalogEnv(["candidate-a"], "preview")).toEqual(["candidate-a"]);
  });
});
