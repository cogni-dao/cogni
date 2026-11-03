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
import { nodeCatalogPolicy } from "@/features/node-deploy/node-catalog-policy";

const POLY = "4b06359a-0000-4000-8000-0000000000aa";
const INREPO = "11111111-1111-4111-8111-111111111111";

function image(): string {
  const root = mkdtempSync(join(tmpdir(), "img-catalog-"));
  const cat = join(root, "infra", "catalog");
  mkdirSync(cat, { recursive: true });
  writeFileSync(join(cat, "_schema.json"), "{}");
  writeFileSync(
    join(cat, "poly.yaml"),
    `name: poly\nsource_repo: https://github.com/x/poly.git\nnode_id: ${POLY}\nrequired_placement_countries:\n  production: [FI, NL]\n`
  );
  writeFileSync(join(cat, "operator.yaml"), "name: operator\ntype: node\n");
  mkdirSync(join(root, "nodes", "operator", ".cogni"), { recursive: true });
  writeFileSync(
    join(root, "nodes", "operator", ".cogni", "repo-spec.yaml"),
    `node_id: "${INREPO}"\n`
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

  it("REAL catalog: the operator resolves via its repo-spec, poly via node_id, and poly's policy is the Polymarket-permitted set with its pool limits", async () => {
    const repoRoot = resolve(__dirname, "../../../../../../..");
    const catalog = new ImageCatalogNodes({ root: repoRoot });
    expect(
      (await catalog.entryFor("4ff8eac1-4eba-4ed0-931b-b1fe4f64713d"))?.slug
    ).toBe("operator");
    const poly = await catalog.entryFor("4b06359a-a859-4399-888e-a8c7a6696f7e");
    expect(poly?.slug).toBe("poly");
    const production = nodeCatalogPolicy(poly?.row, "production");
    expect(production.requiredCountryCodes).toEqual(["FI", "NL", "PT", "UA"]);
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
});
