// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-repo-write` (resolveNodeSource test)
 * Purpose: Pin that a node's source repo AND image repository come from its catalog row, with the
 *   same discriminator as `resolveNodeRepo` (story.5127). The catalog read is stubbed; no GitHub IO.
 * Side-effects: none
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubRepoWriter } from "./github-repo-write";

const input = { parentOwner: "cogni-dao", parentRepo: "cogni", slug: "toks5" };

const TOKS5 = `name: toks5
type: node
path_prefix: nodes/toks5/
source_repo: https://github.com/cogni-dao/toks5.git
image_repository: ghcr.io/cogni-dao/toks5
`;
const OPERATOR = `name: operator
type: node
path_prefix: nodes/operator/
`;

function writerWithCatalog(text: string | null): GitHubRepoWriter {
  const writer = new GitHubRepoWriter({
    appId: "1",
    privateKey: "unused",
  } as ConstructorParameters<typeof GitHubRepoWriter>[0]);
  vi.spyOn(writer, "fetchFileText").mockResolvedValue(text);
  return writer;
}

afterEach(() => vi.restoreAllMocks());

describe("GitHubRepoWriter.resolveNodeSource", () => {
  it("resolves a remote-source node to its own repo and image repository", async () => {
    const writer = writerWithCatalog(TOKS5);
    await expect(writer.resolveNodeSource(input)).resolves.toEqual({
      owner: "cogni-dao",
      repo: "toks5",
      imageRepository: "ghcr.io/cogni-dao/toks5",
    });
    expect(writer.fetchFileText).toHaveBeenCalledWith({
      owner: "cogni-dao",
      repo: "cogni",
      path: "infra/catalog/toks5.yaml",
      ref: "main",
    });
    await expect(writer.resolveNodeRepo(input)).resolves.toEqual({
      owner: "cogni-dao",
      repo: "toks5",
    });
  });

  it("keeps an in-repo node (the operator) on the parent repo with no image repository", async () => {
    const writer = writerWithCatalog(OPERATOR);
    await expect(
      writer.resolveNodeSource({ ...input, slug: "operator" })
    ).resolves.toEqual({
      owner: "cogni-dao",
      repo: "cogni",
      imageRepository: null,
    });
  });

  it("fails catalog_missing for an absent row or a different node name", async () => {
    await expect(
      writerWithCatalog(null).resolveNodeSource(input)
    ).rejects.toMatchObject({ code: "catalog_missing", status: 404 });
    await expect(
      writerWithCatalog(OPERATOR).resolveNodeSource(input)
    ).rejects.toMatchObject({ code: "catalog_missing", status: 404 });
  });

  it("refuses an image repository that does not match the source repo", async () => {
    const writer = writerWithCatalog(
      TOKS5.replace("ghcr.io/cogni-dao/toks5", "ghcr.io/evil/other")
    );
    await expect(writer.resolveNodeSource(input)).rejects.toMatchObject({
      code: "image_repository_mismatch",
    });
  });
});
