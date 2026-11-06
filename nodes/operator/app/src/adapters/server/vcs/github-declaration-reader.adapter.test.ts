// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-declaration-reader.adapter` (test)
 * Purpose: Pin the anonymous public declaration read and its composition behind the operator App read
 *   (story.5137): the App is tried first and is unchanged when installed; only "App not installed" falls
 *   back to the anonymous read; any other App failure is thrown. `fetch` is stubbed; no network.
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";

import {
  AppOrPublicDeclarationReader,
  GitHubPublicReader,
  MAX_FILE_BYTES,
} from "./github-declaration-reader.adapter";
import { GITHUB_APP_NOT_INSTALLED } from "./github-repo-write";

const SHA = "3521b6422693fbbe1c7f80fe9ed9f476721e0970";
const target = { owner: "cogni-dao", repo: "toks5" };

const notInstalled = () =>
  Object.assign(new Error("GitHub App not installed"), {
    code: GITHUB_APP_NOT_INSTALLED,
  });

describe("GitHubPublicReader", () => {
  it("reads a file at the sha anonymously from the raw host (no credential header)", async () => {
    const fetchImpl = vi.fn(async () => new Response("node_id: x\n"));
    const reader = new GitHubPublicReader(fetchImpl as unknown as typeof fetch);
    await expect(
      reader.fetchFileText({
        ...target,
        path: ".cogni/repo-spec.yaml",
        ref: SHA,
      })
    ).resolves.toBe("node_id: x\n");
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit?][];
    expect(calls[0]?.[0]).toBe(
      `https://raw.githubusercontent.com/cogni-dao/toks5/${SHA}/.cogni/repo-spec.yaml`
    );
    expect(calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("reads a missing file as null, a server error as a throw, and an oversized body as a throw", async () => {
    const respond = (response: Response) =>
      new GitHubPublicReader((async () => response) as unknown as typeof fetch);
    const input = { ...target, path: ".cogni/repo-spec.yaml", ref: SHA };
    await expect(
      respond(new Response("", { status: 404 })).fetchFileText(input)
    ).resolves.toBeNull();
    await expect(
      respond(new Response("", { status: 503 })).fetchFileText(input)
    ).rejects.toThrow("HTTP 503");
    await expect(
      respond(new Response("x".repeat(MAX_FILE_BYTES + 1))).fetchFileText(input)
    ).rejects.toThrow("size cap");
  });

  it("refuses a target that could escape the repo path", async () => {
    const fetchImpl = vi.fn();
    const reader = new GitHubPublicReader(fetchImpl as unknown as typeof fetch);
    await expect(
      reader.fetchFileText({ ...target, path: "../etc/passwd", ref: SHA })
    ).rejects.toThrow("invalid public read target");
    await expect(
      reader.fetchFileText({ owner: "a/b", repo: "c", path: "x", ref: SHA })
    ).rejects.toThrow("invalid public read target");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("lists a directory at the sha and maps a submodule entry like the App read", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              name: "a.yaml",
              type: "file",
              size: 10,
              git_url: "https://x/git/blobs/1",
            },
            {
              name: "sub",
              type: "file",
              size: 0,
              git_url: "https://x/git/trees/2",
            },
          ])
        )
    );
    const reader = new GitHubPublicReader(fetchImpl as unknown as typeof fetch);
    await expect(
      reader.listDirectoryEntries({
        ...target,
        path: ".cogni/workloads",
        ref: SHA,
      })
    ).resolves.toEqual([
      { name: "a.yaml", type: "file", size: 10 },
      { name: "sub", type: "submodule", size: 0 },
    ]);
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit?][];
    expect(calls[0]?.[0]).toBe(
      `https://api.github.com/repos/cogni-dao/toks5/contents/.cogni/workloads?ref=${SHA}`
    );
  });

  it("reads an absent directory as null", async () => {
    const reader = new GitHubPublicReader(
      (async () => new Response("", { status: 404 })) as unknown as typeof fetch
    );
    await expect(
      reader.listDirectoryEntries({
        ...target,
        path: ".cogni/workloads",
        ref: SHA,
      })
    ).resolves.toBeNull();
  });
});

describe("AppOrPublicDeclarationReader", () => {
  const readInput = { ...target, path: ".cogni/repo-spec.yaml", ref: SHA };
  const make = () => {
    const app = { fetchFileText: vi.fn(), listDirectoryEntries: vi.fn() };
    const pub = { fetchFileText: vi.fn(), listDirectoryEntries: vi.fn() };
    return { app, pub, reader: new AppOrPublicDeclarationReader(app, pub) };
  };

  it("uses the App when it is installed and never touches the anonymous reader", async () => {
    const { app, pub, reader } = make();
    app.fetchFileText.mockResolvedValue("from app");
    app.listDirectoryEntries.mockResolvedValue([]);
    await expect(reader.fetchFileText(readInput)).resolves.toBe("from app");
    await expect(
      reader.listDirectoryEntries({
        ...target,
        path: ".cogni/workloads",
        ref: SHA,
      })
    ).resolves.toEqual([]);
    expect(pub.fetchFileText).not.toHaveBeenCalled();
    expect(pub.listDirectoryEntries).not.toHaveBeenCalled();
  });

  it("falls back to the anonymous read when the App is not installed, and does not retry the App for that repo", async () => {
    const { app, pub, reader } = make();
    app.fetchFileText.mockRejectedValue(notInstalled());
    pub.fetchFileText.mockResolvedValue("from public");
    pub.listDirectoryEntries.mockResolvedValue([]);
    await expect(reader.fetchFileText(readInput)).resolves.toBe("from public");
    await reader.listDirectoryEntries({
      ...target,
      path: ".cogni/workloads",
      ref: SHA,
    });
    expect(app.fetchFileText).toHaveBeenCalledTimes(1);
    expect(app.listDirectoryEntries).not.toHaveBeenCalled();
    expect(pub.listDirectoryEntries).toHaveBeenCalledTimes(1);
  });

  it("throws any other App failure instead of masking it with a public read", async () => {
    const { app, pub, reader } = make();
    app.fetchFileText.mockRejectedValue(new Error("Bad credentials"));
    await expect(reader.fetchFileText(readInput)).rejects.toThrow(
      "Bad credentials"
    );
    expect(pub.fetchFileText).not.toHaveBeenCalled();
  });
});
