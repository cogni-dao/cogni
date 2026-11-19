// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/shared/config/service-links`
 * Purpose: Pin the Git-declared list of nodes git-review may call (task.5448): the parse, the missing-section
 *   rule, the catalog parity of every `node_id`, and the count of entries (`parseLinkTargets` drops bad ones silently).
 * Scope: The pure parse and the committed `nodes/operator/.cogni/service-links.yaml` file. No env, no network.
 * Invariants:
 *   - MISSING_MEANS_NONE: a missing environment section, or a bad shape, is no targets.
 *   - PARITY: every listed `node_id` equals the `node_id` of the `infra/catalog/<alias>.yaml` entry of the same name.
 *   - NOTHING_DROPPED: the parsed count equals the declared count for every environment.
 * Side-effects: none
 * Links: src/shared/config/service-links.server.ts, nodes/operator/.cogni/service-links.yaml
 * @internal
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { parseServiceLinks } from "@/shared/config/service-links.server";

const REPO_ROOT = fileURLToPath(
  new URL("../../../../../../../", import.meta.url)
);
const LINKS_FILE = `${REPO_ROOT}nodes/operator/.cogni/service-links.yaml`;
const NODE_TEMPLATE_ID = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c";

const doc = parseYaml(fs.readFileSync(LINKS_FILE, "utf8")) as Record<
  string,
  { targets?: unknown[] }
>;

describe("service-links.yaml (task.5448)", () => {
  it("lists node-template for candidate-a and production, nothing for preview", () => {
    expect(parseServiceLinks(doc, "candidate-a")).toEqual([
      {
        alias: "node-template",
        nodeId: NODE_TEMPLATE_ID,
        origin: "https://node-template-test.cognidao.org",
      },
    ]);
    expect(parseServiceLinks(doc, "production")).toEqual([
      {
        alias: "node-template",
        nodeId: NODE_TEMPLATE_ID,
        origin: "https://node-template.cognidao.org",
      },
    ]);
    expect(parseServiceLinks(doc, "preview")).toEqual([]);
  });

  it("a missing environment section, an unset environment or a bad document is no targets", () => {
    expect(parseServiceLinks(doc, "staging")).toEqual([]);
    expect(parseServiceLinks(doc, undefined)).toEqual([]);
    expect(parseServiceLinks(undefined, "production")).toEqual([]);
    expect(parseServiceLinks([], "production")).toEqual([]);
    expect(parseServiceLinks({ production: [] }, "production")).toEqual([]);
    expect(parseServiceLinks({ production: {} }, "production")).toEqual([]);
  });

  it("counts every declared entry as parsed, so no bad entry is dropped silently", () => {
    for (const [environment, section] of Object.entries(doc)) {
      const declared = section.targets ?? [];
      expect(
        parseServiceLinks(doc, environment).length,
        `${environment}: parsed targets must equal declared targets`
      ).toBe(declared.length);
    }
  });

  it("drops what parseLinkTargets drops (the count test above would catch it)", () => {
    const bad = {
      production: {
        targets: [
          {
            alias: "Bad Alias",
            node_id: NODE_TEMPLATE_ID,
            origin: "https://x.test",
          },
          {
            alias: "ok",
            node_id: NODE_TEMPLATE_ID,
            origin: "http://not-https.test",
          },
        ],
      },
    };
    expect(parseServiceLinks(bad, "production")).toEqual([]);
  });

  it("every node_id equals the node_id of the infra/catalog entry named by its alias", () => {
    for (const [environment, section] of Object.entries(doc)) {
      for (const target of parseServiceLinks(doc, environment)) {
        const catalogFile = `${REPO_ROOT}infra/catalog/${target.alias}.yaml`;
        expect(
          fs.existsSync(catalogFile),
          `${environment}/${target.alias}: infra/catalog/${target.alias}.yaml must exist`
        ).toBe(true);
        const entry = parseYaml(fs.readFileSync(catalogFile, "utf8")) as {
          node_id?: string;
        };
        expect(
          entry.node_id,
          `${environment}/${target.alias}: node_id must match the catalog`
        ).toBe(target.nodeId);
      }
      expect(section).toBeDefined();
    }
  });
});
