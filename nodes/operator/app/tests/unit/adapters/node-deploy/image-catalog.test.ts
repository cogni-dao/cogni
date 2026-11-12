// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/image-catalog`
 * Purpose: Prove node id -> { slug, row } resolution from the catalog baked into the image: submodule
 *   rows via their `node_id` projection, in-repo rows via their repo-spec, everything else ignored
 *   (task.5405). Also pins the REAL repo catalog: the operator and the poly row resolve.
 * Side-effects: filesystem (a temp directory; read-only on the real catalog)
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ImageCatalogNodes } from "@/adapters/server";
import { edgeHostRegexFor } from "@/features/node-deploy/edge";
import {
  catalogDeclaresPlacement,
  nodeCatalogPolicy,
} from "@/features/node-deploy/node-catalog-policy";
import { resolveWorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";

const POLY = "4b06359a-0000-4000-8000-0000000000aa";
const INREPO = "11111111-1111-4111-8111-111111111111";

function image(): string {
  const root = mkdtempSync(join(tmpdir(), "img-catalog-"));
  const cat = join(root, "infra", "catalog");
  mkdirSync(cat, { recursive: true });
  writeFileSync(join(cat, "_schema.json"), "{}");
  writeFileSync(
    join(cat, "poly.yaml"),
    `name: poly\nsource_repo: https://github.com/cogni-dao/poly.git\nnode_id: ${POLY}\nrequired_placement_countries:\n  production: [FI, NL]\ncompute_api:\n  candidate-a: node-deploy\n  production: node-deploy\n`
  );
  writeFileSync(join(cat, "operator.yaml"), "name: operator\ntype: node\n");
  mkdirSync(join(root, "nodes", "operator", ".cogni"), { recursive: true });
  writeFileSync(
    join(root, "nodes", "operator", ".cogni", "repo-spec.yaml"),
    `node_id: "${INREPO}"\n`
  );
  // Independent, stable fleet and environment combinations exercise the selector.
  writeFileSync(
    join(cat, "preview-only.yaml"),
    "name: preview-only\nsource_repo: https://github.com/cogni-dao/preview-only.git\ncompute_api:\n  preview: node-deploy\n  production: legacy\n"
  );
  writeFileSync(
    join(cat, "other-fleet.yaml"),
    "name: other-fleet\nsource_repo: https://github.com/cogni-test-org/other-fleet.git\ncompute_api:\n  candidate-a: node-deploy\n"
  );
  // ignored: name does not match the file stem; submodule row without a projected id
  writeFileSync(join(cat, "liar.yaml"), `name: other\nnode_id: ${POLY}\n`);
  writeFileSync(
    join(cat, "noid.yaml"),
    "name: noid\nsource_repo: https://github.com/x/noid.git\n"
  );
  return root;
}

describe("ImageCatalogNodes", () => {
  it("resolves a submodule row by its node_id projection and an in-repo row by its repo-spec", async () => {
    const catalog = new ImageCatalogNodes({ root: image() });
    expect((await catalog.entryFor(POLY))?.slug).toBe("poly");
    expect((await catalog.entryFor(POLY.toUpperCase()))?.slug).toBe("poly");
    expect((await catalog.entryFor(INREPO))?.slug).toBe("operator");
    expect(await catalog.entryFor("22222222-2222-4222-8222-222222222222")).toBe(
      undefined
    );
  });

  it("the row feeds the placement policy the sequencer applies", async () => {
    const entry = await new ImageCatalogNodes({ root: image() }).entryFor(POLY);
    expect(
      nodeCatalogPolicy(entry?.row, "production").requiredCountryCodes
    ).toEqual(["FI", "NL"]);
    expect(
      nodeCatalogPolicy(entry?.row, "candidate-a").requiredCountryCodes
    ).toEqual([]);
  });

  it("REAL catalog: the operator resolves via its repo-spec, poly via node_id, and poly holds no catalog countries (its manifest owns them, story.5141) but keeps its pool limits", async () => {
    const repoRoot = resolve(__dirname, "../../../../../../..");
    const catalog = new ImageCatalogNodes({ root: repoRoot });
    expect(
      (await catalog.entryFor("4ff8eac1-4eba-4ed0-931b-b1fe4f64713d"))?.slug
    ).toBe("operator");
    const poly = await catalog.entryFor("4b06359a-a859-4399-888e-a8c7a6696f7e");
    expect(poly?.slug).toBe("poly");
    const production = nodeCatalogPolicy(poly?.row, "production");
    // ONE_PLACEMENT_WRITER (CD4): Poly's set lives in its own manifest, so its catalog row must name no
    // country in ANY env; a cell here would make every Poly manifest release a 409 two-writer refusal.
    for (const env of ["candidate-a", "preview", "production"]) {
      expect(nodeCatalogPolicy(poly?.row, env).requiredCountryCodes).toEqual(
        []
      );
      expect(catalogDeclaresPlacement(poly?.row, env)).toBe(false);
    }
    expect(production.databasePoolLimits).toEqual({
      replicaCount: 1,
      app: 3,
      service: 4,
      read: 2,
    });
    expect(
      (await catalog.entryFor("b927a9dd-6132-4fc9-a51e-e3cee2568e3c"))?.slug
    ).toBe("node-template");
    expect(
      nodeCatalogPolicy(
        (await catalog.entryFor("b927a9dd-6132-4fc9-a51e-e3cee2568e3c"))?.row,
        "production"
      ).requiredCountryCodes
    ).toEqual([]);
  });

  it("filters the synthetic catalog by environment, deployment authority, and fleet", async () => {
    const catalog = new ImageCatalogNodes({ root: image() });
    expect(await catalog.nodeDeploySlugs("candidate-a", "cogni-dao")).toEqual([
      "poly",
    ]);
    expect(await catalog.nodeDeploySlugs("preview", "COGNI-DAO")).toEqual([
      "preview-only",
    ]);
    expect(await catalog.nodeDeploySlugs("production", "cogni-dao")).toEqual([
      "poly",
    ]);
    expect(
      await catalog.nodeDeploySlugs("candidate-a", "cogni-test-org")
    ).toEqual(["other-fleet"]);
    expect(await catalog.nodeDeploySlugs("candidate-a", undefined)).toEqual([]);
    expect(
      await catalog.nodeDeploySlugs("production", "cogni-test-org")
    ).toEqual([]);
  });

  it("REAL catalog keeps fleet isolation and refuses operator hosts", async () => {
    const repoRoot = resolve(__dirname, "../../../../../../..");
    const catalog = new ImageCatalogNodes({ root: repoRoot });
    const production = await catalog.nodeDeploySlugs("production", "cogni-dao");
    expect(production).toContain("poly");
    expect(production).not.toContain("operator");
    for (const env of ["candidate-a", "preview", "production"]) {
      const canonical = await catalog.nodeDeploySlugs(env, "cogni-dao");
      const otherFleet = await catalog.nodeDeploySlugs(env, "cogni-test-org");
      expect(otherFleet).not.toContain("poly");
      expect(otherFleet).not.toContain("toks5");
      expect(await catalog.nodeDeploySlugs(env, undefined)).not.toContain(
        "poly"
      );
      expect(
        [...(await catalog.nodeDeploySlugs(env, "COGNI-DAO"))].sort()
      ).toEqual([...canonical].sort());
      expect(canonical).not.toContain("operator");
    }
    const re = edgeHostRegexFor(
      production,
      resolveWorkloadZoneBinding({
        fleetOwner: "cogni-dao",
        zoneName: "cognidao.org",
      })
    );
    expect(re.test("poly.cognidao.org")).toBe(true);
    expect(re.test("cognidao.org")).toBe(false);
  });

  it("ImageCatalogNodeSource refuses an image repository that does not match the source repo", async () => {
    const { ImageCatalogNodeSource } = await import("@/adapters/server");
    const bad = new ImageCatalogNodeSource({
      slugs: async () => ["toks5"],
      entryFor: async () => ({
        slug: "toks5",
        row: {
          name: "toks5",
          type: "node",
          path_prefix: "nodes/toks5/",
          source_repo: "https://github.com/cogni-dao/toks5.git",
          image_repository: "ghcr.io/evil/other",
        },
      }),
    });
    await expect(
      bad.resolveNodeSource({
        nodeId: "f66b260b-4633-41e2-8711-b7c1b8449cc1",
        parentOwner: "cogni-test-org",
        parentRepo: "cogni-monorepo",
      })
    ).rejects.toMatchObject({ code: "image_repository_mismatch" });
  });
});
