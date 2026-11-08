// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/server/vcs/catalog-public-read`
 * Purpose: Pin that the canonical catalog of an env whose GitHub App is NOT installed on the catalog
 *   repo is read anonymously when the repo is public (bug.5596), without weakening the App-first or
 *   private-repo behavior.
 * Scope: Fake App reader + stubbed fetch; no network, no credential.
 * Side-effects: none
 * Links: src/adapters/server/vcs/github-repo-write.ts (listCatalogNodesVia),
 *   src/adapters/server/vcs/github-declaration-reader.adapter.ts
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  AppOrPublicDeclarationReader,
  GitHubPublicReader,
} from "@/adapters/server/vcs/github-declaration-reader.adapter";
import {
  GITHUB_APP_NOT_INSTALLED,
  listCatalogNodesVia,
} from "@/adapters/server/vcs/github-repo-write";
import type { DeclarationReadPort } from "@/ports";

const input = {
  parentOwner: "cogni-dao",
  parentRepo: "cogni",
  sourceRef: "main",
};

const TEMPLATE_ID = "b927a9dd-0000-4000-8000-000000000001";
const CATALOG_ROW = `name: node-template
type: node
node_id: ${TEMPLATE_ID}
source_repo: https://github.com/Cogni-DAO/node-template.git
path_prefix: nodes/node-template/
envs: [candidate-a]
activity_env: candidate-a
owner_wallet: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
`;

const notInstalled = () =>
  Object.assign(new Error("GitHub App not installed on cogni-dao/cogni"), {
    code: GITHUB_APP_NOT_INSTALLED,
  });

function notInstalledApp(): DeclarationReadPort {
  return {
    fetchFileText: vi.fn(async () => {
      throw notInstalled();
    }),
    listDirectoryEntries: vi.fn(async () => {
      throw notInstalled();
    }),
  };
}

function publicCatalogFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async (url: string) => {
    if (url.startsWith("https://api.github.com/")) {
      return new Response(
        JSON.stringify([
          { name: "node-template.yaml", type: "file", size: 10 },
          { name: "_schema.json", type: "file", size: 10 },
        ])
      );
    }
    if (url.endsWith("infra/catalog/node-template.yaml"))
      return new Response(CATALOG_ROW);
    return new Response("", { status: 404 });
  });
}

describe("listCatalogNodesVia: public canonical catalog without an App install", () => {
  it("projects node rows by reading anonymously when the App is not installed", async () => {
    const fetchImpl = publicCatalogFetch();
    const reader = new AppOrPublicDeclarationReader(
      notInstalledApp(),
      new GitHubPublicReader(fetchImpl as unknown as typeof fetch)
    );

    await expect(listCatalogNodesVia(reader, input)).resolves.toEqual([
      expect.objectContaining({
        nodeId: TEMPLATE_ID,
        slug: "node-template",
        repoOwner: "Cogni-DAO",
        repoName: "node-template",
      }),
    ]);

    // Only the two fixed GitHub hosts are contacted, and never with a credential.
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit?][];
    expect(calls.length).toBeGreaterThan(0);
    for (const [url, init] of calls) {
      expect(new URL(url).host).toMatch(
        /^(api\.github\.com|raw\.githubusercontent\.com)$/
      );
      expect(JSON.stringify(init?.headers ?? {})).not.toMatch(
        /authorization|token/i
      );
    }
  });

  it("keeps the App read first and never goes anonymous when the App can read the repo", async () => {
    const app: DeclarationReadPort = {
      listDirectoryEntries: vi.fn(async () => [
        { name: "node-template.yaml", type: "file", size: 10 },
      ]),
      fetchFileText: vi.fn(async () => CATALOG_ROW),
    };
    const fetchImpl = vi.fn();
    const reader = new AppOrPublicDeclarationReader(
      app,
      new GitHubPublicReader(fetchImpl as unknown as typeof fetch)
    );

    await expect(listCatalogNodesVia(reader, input)).resolves.toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reads a private repo (not installed, not public) as a missing catalog", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 404 }));
    const reader = new AppOrPublicDeclarationReader(
      notInstalledApp(),
      new GitHubPublicReader(fetchImpl as unknown as typeof fetch)
    );

    await expect(listCatalogNodesVia(reader, input)).rejects.toMatchObject({
      code: "catalog_missing",
      status: 404,
    });
  });

  it("does not mask a real App failure with an anonymous read", async () => {
    const app: DeclarationReadPort = {
      listDirectoryEntries: vi.fn(async () => {
        throw new Error("GitHub 503");
      }),
      fetchFileText: vi.fn(),
    };
    const fetchImpl = vi.fn();
    const reader = new AppOrPublicDeclarationReader(
      app,
      new GitHubPublicReader(fetchImpl as unknown as typeof fetch)
    );

    await expect(listCatalogNodesVia(reader, input)).rejects.toThrow(
      "GitHub 503"
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
