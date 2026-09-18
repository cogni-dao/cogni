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
  envRemovalViolation,
  hasCatalogSourceRepo,
  parseCatalogActivityEnv,
  parseCatalogEnvs,
  parseCatalogPlacement,
  parseCatalogPlacementMap,
  parseCatalogSourceRepo,
  setCatalogEnvs,
  setCatalogPlacement,
  setCatalogPlacementCell,
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
activity_env: candidate-a
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

  it("rejects an empty deploy set", () => {
    expect(() => setCatalogEnvs(CATALOG, [])).toThrow(/at least one/);
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
    const lastLine =
      "name: blue\ntype: node\nenvs: [candidate-a, preview, production]\n";
    const next = setCatalogEnvs(lastLine, ["preview", "production"]);
    expect(next).toBe("name: blue\ntype: node\nenvs: [preview, production]\n");
    expect(next.endsWith("]\n")).toBe(true);
  });
});

describe("activity authority removal", () => {
  it("parses the catalog activity authority", () => {
    expect(parseCatalogActivityEnv(CATALOG)).toBe("candidate-a");
  });

  it("rejects the final environment before considering authority transfer", () => {
    expect(
      envRemovalViolation({
        currentEnvs: ["candidate-a"],
        activityEnv: "candidate-a",
        removeEnv: "candidate-a",
      })
    ).toBe("final_environment_required");
  });

  it("rejects removing activity authority from a multi-env deployment", () => {
    expect(
      envRemovalViolation({
        currentEnvs: ["candidate-a", "production"],
        activityEnv: "candidate-a",
        removeEnv: "candidate-a",
      })
    ).toBe("activity_authority_cutover_required");
  });
});

// toks4-shaped: an external-build row (source_repo) whose block sits after envs:, with a
// trailing comment block that must survive every placement edit verbatim.
const CATALOG_WITH_PLACEMENT = `name: toks
type: node
port: 3200
node_port: 31700
source_repo: https://github.com/cogni-dao/toks.git
image_repository: ghcr.io/cogni-dao/toks
envs: [candidate-a, preview, production]
deployment_provider:
  candidate-a: akash
  production: akash
activity_env: candidate-a
# trailing comment that must survive verbatim.
path_prefix: nodes/toks/
`;

describe("parseCatalogPlacement", () => {
  it("reads the per-env map; absent envs mean the k3s default", () => {
    expect(parseCatalogPlacement(CATALOG_WITH_PLACEMENT)).toEqual({
      "candidate-a": "akash",
      production: "akash",
    });
  });

  it("returns {} when the block is absent", () => {
    expect(parseCatalogPlacement(CATALOG)).toEqual({});
  });

  it("throws on an unknown env key", () => {
    expect(() =>
      parseCatalogPlacement(
        CATALOG_WITH_PLACEMENT.replace(
          "  production: akash",
          "  staging: akash"
        )
      )
    ).toThrow(/unknown env/);
  });

  it("throws on an unknown provider value", () => {
    expect(() =>
      parseCatalogPlacement(
        CATALOG_WITH_PLACEMENT.replace(
          "  production: akash",
          "  production: fly"
        )
      )
    ).toThrow(/unknown value/);
  });

  it("tolerates a trailing `# comment` after the provider value (mirrors activity_env)", () => {
    const commented = CATALOG_WITH_PLACEMENT.replace(
      "  production: akash",
      "  production: akash  # toks4 normalization pending"
    );
    expect(parseCatalogPlacement(commented)).toEqual({
      "candidate-a": "akash",
      production: "akash",
    });
  });
});

describe("setCatalogPlacement", () => {
  it("creates the block after the envs: line when absent (akash)", () => {
    const next = setCatalogPlacement(CATALOG, "preview", "akash");
    expect(next).toContain(
      "envs: [candidate-a, preview, production]\ndeployment_provider:\n  preview: akash\nactivity_env: candidate-a"
    );
    expect(parseCatalogPlacement(next)).toEqual({ preview: "akash" });
    // Every pre-existing line is preserved verbatim.
    for (const line of CATALOG.split("\n")) {
      expect(next).toContain(line);
    }
  });

  it("upserts an env into an existing block in canonical order", () => {
    const next = setCatalogPlacement(
      CATALOG_WITH_PLACEMENT,
      "preview",
      "akash"
    );
    expect(next).toContain(
      "deployment_provider:\n  candidate-a: akash\n  preview: akash\n  production: akash\n"
    );
  });

  it("k3s removes the env's entry (k3s is the schema default), keeping others", () => {
    const next = setCatalogPlacement(
      CATALOG_WITH_PLACEMENT,
      "production",
      "k3s"
    );
    expect(next).toContain("deployment_provider:\n  candidate-a: akash\n");
    expect(next).not.toContain("production: akash");
    expect(next).toContain("# trailing comment that must survive verbatim.");
  });

  it("drops the whole block once it empties (minProperties: 1)", () => {
    const one = setCatalogPlacement(
      CATALOG_WITH_PLACEMENT,
      "production",
      "k3s"
    );
    const none = setCatalogPlacement(one, "candidate-a", "k3s");
    expect(none).not.toContain("deployment_provider");
    // Round-trips back to the block-less form byte-exactly.
    expect(none).toBe(
      CATALOG_WITH_PLACEMENT.replace(
        "deployment_provider:\n  candidate-a: akash\n  production: akash\n",
        ""
      )
    );
  });

  it("k3s onto a block-less row is a byte-exact no-op", () => {
    expect(setCatalogPlacement(CATALOG, "preview", "k3s")).toBe(CATALOG);
  });

  it("akash onto an already-akash env is a byte-exact no-op", () => {
    expect(
      setCatalogPlacement(CATALOG_WITH_PLACEMENT, "production", "akash")
    ).toBe(CATALOG_WITH_PLACEMENT);
  });

  it("preserves the trailing newline when the block ends the file", () => {
    const tail = `name: toks
envs: [candidate-a]
deployment_provider:
  candidate-a: akash
`;
    const next = setCatalogPlacement(tail, "candidate-a", "k3s");
    expect(next).toBe("name: toks\nenvs: [candidate-a]\n");
    const back = setCatalogPlacement(next, "candidate-a", "akash");
    expect(back).toBe(tail);
  });
});

describe("hasCatalogSourceRepo", () => {
  it("detects an external build plane", () => {
    expect(hasCatalogSourceRepo(CATALOG_WITH_PLACEMENT)).toBe(true);
    expect(hasCatalogSourceRepo(CATALOG)).toBe(false);
  });
});

describe("parseCatalogSourceRepo", () => {
  it("reads the source_repo URL", () => {
    expect(parseCatalogSourceRepo(CATALOG_WITH_PLACEMENT)).toBe(
      "https://github.com/cogni-dao/toks.git"
    );
  });

  it("throws when the row has no external build plane", () => {
    expect(() => parseCatalogSourceRepo(CATALOG)).toThrow(/source_repo/);
  });
});

// ── Generalized per-key placement cell editors (story.5039) ─────────────────────────────────────

// A poly-shaped row: all three placement blocks present, with the top-level comments between them
// that every cell edit must carry through verbatim.
const CATALOG_WITH_ALL_CELLS = `name: toks
type: node
port: 3200
node_port: 31700
source_repo: https://github.com/cogni-dao/toks.git
image_repository: ghcr.io/cogni-dao/toks
envs: [candidate-a, production]
deployment_provider:
  candidate-a: akash
  production: akash
# authority comment that must survive verbatim.
compute_api:
  production: crossplane
# lease counter comment that must survive verbatim.
lease_generation:
  production: 0
activity_env: production
path_prefix: nodes/toks/
`;

describe("parseCatalogPlacementMap", () => {
  it("reads each key's per-env cells independently", () => {
    expect(
      parseCatalogPlacementMap(CATALOG_WITH_ALL_CELLS, "deployment_provider")
    ).toEqual({ "candidate-a": "akash", production: "akash" });
    expect(
      parseCatalogPlacementMap(CATALOG_WITH_ALL_CELLS, "compute_api")
    ).toEqual({ production: "crossplane" });
    expect(
      parseCatalogPlacementMap(CATALOG_WITH_ALL_CELLS, "lease_generation")
    ).toEqual({ production: "0" });
  });

  it("throws on a value outside the key's vocabulary", () => {
    expect(() =>
      parseCatalogPlacementMap(
        CATALOG_WITH_ALL_CELLS.replace(
          "  production: crossplane",
          "  production: akash"
        ),
        "compute_api"
      )
    ).toThrow(/unknown value/);
  });
});

describe("setCatalogPlacementCell", () => {
  it("upserts a cell into an existing block, preserving surrounding comments", () => {
    const next = setCatalogPlacementCell(
      CATALOG_WITH_ALL_CELLS,
      "compute_api",
      "candidate-a",
      "crossplane"
    );
    expect(next).toContain(
      "compute_api:\n  candidate-a: crossplane\n  production: crossplane\n"
    );
    expect(next).toContain("# authority comment that must survive verbatim.");
    expect(next).toContain(
      "# lease counter comment that must survive verbatim."
    );
  });

  it("inserts a NEW compute_api block after the deployment_provider block (#2301 ordering)", () => {
    const noComputeApi = CATALOG_WITH_ALL_CELLS.replace(
      "compute_api:\n  production: crossplane\n",
      ""
    );
    const next = setCatalogPlacementCell(
      noComputeApi,
      "compute_api",
      "production",
      "crossplane"
    );
    expect(next).toContain(
      "deployment_provider:\n  candidate-a: akash\n  production: akash\ncompute_api:\n  production: crossplane\n"
    );
  });

  it("inserts a NEW lease_generation block after compute_api when present, else after deployment_provider", () => {
    const noLease = CATALOG_WITH_ALL_CELLS.replace(
      "lease_generation:\n  production: 0\n",
      ""
    );
    const afterComputeApi = setCatalogPlacementCell(
      noLease,
      "lease_generation",
      "production",
      "0"
    );
    expect(afterComputeApi).toContain(
      "compute_api:\n  production: crossplane\nlease_generation:\n  production: 0\n"
    );

    const neither = noLease.replace(
      "compute_api:\n  production: crossplane\n",
      ""
    );
    const afterProvider = setCatalogPlacementCell(
      neither,
      "lease_generation",
      "production",
      "0"
    );
    expect(afterProvider).toContain(
      "deployment_provider:\n  candidate-a: akash\n  production: akash\nlease_generation:\n  production: 0\n"
    );
  });

  it("falls back to inserting after the envs: line when no predecessor block exists", () => {
    const next = setCatalogPlacementCell(
      CATALOG,
      "deployment_provider",
      "preview",
      "akash"
    );
    expect(next).toContain(
      "envs: [candidate-a, preview, production]\ndeployment_provider:\n  preview: akash\nactivity_env: candidate-a"
    );
  });

  it("removing the last cell drops the whole block (minProperties: 1)", () => {
    const next = setCatalogPlacementCell(
      CATALOG_WITH_ALL_CELLS,
      "lease_generation",
      "production",
      undefined
    );
    expect(next).not.toContain("lease_generation");
    // Its neighbour comment (outside the block capture) survives.
    expect(next).toContain(
      "# lease counter comment that must survive verbatim."
    );
  });

  it("rejects a value outside the key's vocabulary", () => {
    expect(() =>
      setCatalogPlacementCell(
        CATALOG_WITH_ALL_CELLS,
        "lease_generation",
        "production",
        "-1"
      )
    ).toThrow(/unknown value/);
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
