// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-repo-write`
 * Purpose: Operator-only helper that commits a single file and opens a pull request via the GitHub App.
 * Scope: Two thin Octokit calls behind one entry point; reuses GitHub App installation auth (cogni-node-template).
 *   Does not belong in `VcsCapability` because that capability is shared with poly/resy/node-template stubs
 *   and these write ops are operator-only.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED: caller must verify the app is installed on the target repo; we surface a
 *     clear error if not. Public-repo install is sufficient for v0.
 *   - SINGLE_FILE_COMMIT: writes exactly one file path; no multi-file orchestration.
 *   - PR_AGAINST_BASE_REF: opens a PR with the given title/body against `baseRef`; never force-pushes.
 * Side-effects: IO (GitHub REST API)
 * Links: docs/spec/node-formation.md, task.5083
 * @internal
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";

import {
  insertAppsetStanza,
  insertCaddyBlock,
  insertLockfileImporters,
  insertSchedulerEndpoint,
  insertScopeFilter,
  nextFreeNodePort,
  renderCatalog,
  renderOverlay,
  renderRepoSpec,
} from "@/features/node-app-scaffold/gens";

export interface GitHubRepoWriterConfig {
  readonly appId: string;
  readonly privateKey: string;
}

export interface CommitFileAndOpenPrInput {
  readonly owner: string;
  readonly repo: string;
  readonly baseRef: string;
  readonly headBranch: string;
  readonly path: string;
  readonly content: string;
  readonly commitMessage: string;
  readonly prTitle: string;
  readonly prBody: string;
}

export interface CommitFileAndOpenPrResult {
  readonly prNumber: number;
  readonly prUrl: string;
  readonly headSha: string;
}

export interface OpenNodeAppPrInput {
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
  readonly nodeId: string;
  readonly chainId: number;
  readonly daoContract?: string;
  readonly pluginContract?: string;
  readonly signalContract?: string;
}

export interface OpenNodeAppPrResult {
  readonly prNumber: number;
  readonly prUrl: string;
}

/** One entry in a `POST /git/trees` payload; `sha: null` deletes the path from `base_tree`. */
interface GitTreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "040000" | "160000" | "120000";
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string | null;
}

/**
 * Envs a node is born into (ALL_THREE_ENVS_OR_NONE), mirroring `scaffold-node.sh` `ENVS=(…)`.
 * candidate-b/canary overlay dirs are not part of the birth set.
 */
const NODE_BIRTH_ENVS = ["candidate-a", "preview", "production"] as const;
const TEMPLATE_SLUG = "node-template";
const CONTAINER_PORT = 3200;

/** Footprint files edited in-place by the node-birth PR (single-file gens over current main). */
const FOOTPRINT = {
  caddyfile: "infra/compose/edge/configs/Caddyfile.tmpl",
  ciYaml: ".github/workflows/ci.yaml",
  schedulerConfigmap: "infra/k8s/base/scheduler-worker/configmap.yaml",
  lockfile: "pnpm-lock.yaml",
} as const;

/**
 * Text files inside `nodes/node-template/` that name `node-template` and must be rewritten to the
 * new slug to match `scaffold-node.sh`'s global `s/node-template/<slug>/g`. Paths are relative to
 * the node root. Derived from `git grep -Il node-template -- 'nodes/node-template/**'`, minus the
 * two paths handled specially below (`.cogni/repo-spec.yaml` is regenerated; `k8s/external-secrets`
 * is deleted). A blob present in the template but absent here would simply not be renamed — the only
 * cost is a stale `node-template` literal, caught by the single-node-scope + drift gates in CI.
 */
const NODE_RENAME_PATHS: readonly string[] = [
  "app/Dockerfile",
  "app/package.json",
  "app/src/app/layout.tsx",
  "app/src/components/vendor/assistant-ui/tool-ui-registry.tsx",
  "app/src/instrumentation.ts",
  "drizzle.config.ts",
  "drizzle.doltgres.config.ts",
  "graphs/package.json",
  "packages/doltgres-schema/AGENTS.md",
  "packages/doltgres-schema/package.json",
  "packages/doltgres-schema/src/index.ts",
  "packages/doltgres-schema/src/knowledge.ts",
  "packages/doltgres-schema/src/work-items.ts",
  "packages/doltgres-schema/stamp-commit.mjs",
  "packages/doltgres-schema/tsup.config.ts",
];

/**
 * Subtrees cloned with the node but DELETED in the new node's tree (sha:null).
 * bug.5086 Part D — cloning `.cogni/secrets-catalog.yaml` re-declares the ~57 shared baseline names
 * → NO_NAME_COLLISIONS throw → kills setup:secrets for every env. `k8s/external-secrets` is per-node
 * ExternalSecret manifests that a fresh clone must not carry. Both are deleted only when present.
 */
const NODE_DELETE_PATHS = [
  ".cogni/secrets-catalog.yaml",
  "k8s/external-secrets",
] as const;

export class GitHubRepoWriter {
  private readonly config: GitHubRepoWriterConfig;
  private readonly appAuth: ReturnType<typeof createAppAuth>;

  constructor(config: GitHubRepoWriterConfig) {
    this.config = config;
    this.appAuth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }

  async commitFileAndOpenPr(
    input: CommitFileAndOpenPrInput
  ): Promise<CommitFileAndOpenPrResult> {
    const octokit = await this.getOctokit(input.owner, input.repo);

    // 1. Resolve baseRef → sha (the parent commit for our new branch).
    const { data: baseRefData } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      {
        owner: input.owner,
        repo: input.repo,
        ref: `heads/${input.baseRef}`,
      }
    );
    const baseSha = baseRefData.object.sha;

    // 2. Create the head branch from baseSha (idempotent: ignore "already exists").
    try {
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner: input.owner,
        repo: input.repo,
        ref: `refs/heads/${input.headBranch}`,
        sha: baseSha,
      });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 422) throw err;
    }

    // 3. If the file already exists on headBranch, fetch its blob SHA so the
    //    contents API treats this as an update rather than rejecting.
    let existingSha: string | undefined;
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.headBranch,
        }
      );
      if (!Array.isArray(data) && data.type === "file") {
        existingSha = data.sha;
      }
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 404) throw err;
    }

    // 4. Write the file (single-file commit).
    const { data: commitData } = await octokit.request(
      "PUT /repos/{owner}/{repo}/contents/{path}",
      {
        owner: input.owner,
        repo: input.repo,
        path: input.path,
        message: input.commitMessage,
        content: Buffer.from(input.content, "utf-8").toString("base64"),
        branch: input.headBranch,
        ...(existingSha ? { sha: existingSha } : {}),
      }
    );

    const headSha = commitData.commit?.sha ?? "";

    // 5. Open the PR. If a PR for this head already exists, return it.
    try {
      const { data: pr } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls",
        {
          owner: input.owner,
          repo: input.repo,
          title: input.prTitle,
          body: input.prBody,
          head: input.headBranch,
          base: input.baseRef,
        }
      );
      return { prNumber: pr.number, prUrl: pr.html_url, headSha };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 422) throw err;
      const { data: existing } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        {
          owner: input.owner,
          repo: input.repo,
          state: "open",
          head: `${input.owner}:${input.headBranch}`,
          per_page: 1,
        }
      );
      if (existing.length === 0) {
        throw new Error(
          `Failed to open PR and no open PR found for head ${input.headBranch}`
        );
      }
      const pr = existing[0];
      if (!pr) {
        throw new Error(
          `Failed to open PR and no open PR found for head ${input.headBranch}`
        );
      }
      return {
        prNumber: pr.number,
        prUrl: pr.html_url,
        headSha,
      };
    }
  }

  /**
   * Author a node-birth ("node-app") PR directly, as the App, via the Git Data API. Builds the new
   * `nodes/<slug>` subtree by referencing node-template's existing tree (overriding only the renamed
   * files + the regenerated repo-spec, deleting secrets-catalog + external-secrets), then applies the
   * single-file footprint gens (catalog, overlays×3, appsets×3, Caddyfile, ci.yaml, scheduler
   * configmap, lockfile) atop main's tree in one commit + branch + PR. No checkout, no bash, no
   * per-file upload of the ~1075 unchanged node blobs.
   */
  async openNodeAppPr(input: OpenNodeAppPrInput): Promise<OpenNodeAppPrResult> {
    const { owner, repo, slug } = input;
    const octokit = await this.getOctokit(owner, repo);

    // a. Base commit → its root tree.
    const { data: ref } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      { owner, repo, ref: "heads/main" }
    );
    const baseCommitSha = ref.object.sha;
    const { data: baseCommit } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { owner, repo, commit_sha: baseCommitSha }
    );
    const baseTreeSha = baseCommit.tree.sha;

    // b. Allocate the next free k3s NodePort from the catalog's existing node_port values.
    const nodePort = await this.allocateNodePort(
      octokit,
      owner,
      repo,
      baseTreeSha
    );
    const port = CONTAINER_PORT;

    // c. New node subtree — reference node-template's tree, override only what changes.
    const nodeTreeSha = await this.buildNodeSubtree(
      octokit,
      owner,
      repo,
      baseTreeSha,
      input
    );

    // d. Footprint blobs — current-main content threaded through the single-file gens.
    const footprintEntries = await this.buildFootprintEntries(
      octokit,
      owner,
      repo,
      input,
      port,
      nodePort
    );

    // e. Final tree = main's tree + the node subtree + the footprint blobs.
    const { data: finalTree } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/trees",
      {
        owner,
        repo,
        base_tree: baseTreeSha,
        tree: [
          {
            path: `nodes/${slug}`,
            mode: "040000",
            type: "tree",
            sha: nodeTreeSha,
          },
          ...footprintEntries,
        ],
      }
    );

    // f. Commit → branch (idempotent) → PR.
    const branch = `cogni-operator/node-bootstrap-${slug}`;
    const { data: commit } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/commits",
      {
        owner,
        repo,
        message: `feat(node): bootstrap node-app for ${slug}`,
        tree: finalTree.sha,
        parents: [baseCommitSha],
      }
    );
    await this.upsertRef(octokit, owner, repo, branch, commit.sha);
    return this.openOrFindPr(octokit, owner, repo, slug, branch);
  }

  /** Resolve the next free NodePort: read each `infra/catalog/*.yaml` `node_port`, then `+100`. */
  private async allocateNodePort(
    octokit: Octokit,
    owner: string,
    repo: string,
    baseTreeSha: string
  ): Promise<number> {
    const catalogTreeSha = await this.findTreeEntrySha(
      octokit,
      owner,
      repo,
      baseTreeSha,
      "infra/catalog"
    );
    if (!catalogTreeSha) {
      throw new Error("openNodeAppPr: infra/catalog tree not found on main");
    }
    const { data: catalogTree } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: catalogTreeSha }
    );
    const yamlBlobs = catalogTree.tree.filter(
      (e) => e.type === "blob" && (e.path ?? "").endsWith(".yaml")
    );
    const ports: number[] = [];
    for (const entry of yamlBlobs) {
      if (!entry.sha) continue;
      const text = await this.readBlob(octokit, owner, repo, entry.sha);
      const m = /^node_port:\s*(\d+)\s*$/m.exec(text);
      if (m) ports.push(Number(m[1]));
    }
    return nextFreeNodePort(ports);
  }

  /**
   * Build the `nodes/<slug>` subtree by basing on node-template's tree and overriding only:
   *   - the renamed text files (node-template → slug), as new blobs;
   *   - `.cogni/repo-spec.yaml` = renderRepoSpec(...);
   *   - DELETE `.cogni/secrets-catalog.yaml` + `k8s/external-secrets` (sha:null, when present).
   */
  private async buildNodeSubtree(
    octokit: Octokit,
    owner: string,
    repo: string,
    baseTreeSha: string,
    input: OpenNodeAppPrInput
  ): Promise<string> {
    const { slug } = input;
    const templateTreeSha = await this.findTreeEntrySha(
      octokit,
      owner,
      repo,
      baseTreeSha,
      `nodes/${TEMPLATE_SLUG}`
    );
    if (!templateTreeSha) {
      throw new Error(
        `openNodeAppPr: nodes/${TEMPLATE_SLUG} tree not found on main`
      );
    }

    // Recursive listing of the template node tree → which delete-paths actually exist.
    const { data: recursive } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: templateTreeSha, recursive: "1" }
    );
    const presentPaths = new Set(recursive.tree.map((e) => e.path ?? ""));

    const overrides: GitTreeEntry[] = [];

    // Renamed text files → new blobs (global node-template → slug, matching scaffold-node.sh).
    for (const path of NODE_RENAME_PATHS) {
      const entry = recursive.tree.find(
        (e) => e.path === path && e.type === "blob"
      );
      if (!entry?.sha) continue;
      const original = await this.readBlob(octokit, owner, repo, entry.sha);
      const rewritten = original.split(TEMPLATE_SLUG).join(slug);
      const blobSha = await this.createBlob(octokit, owner, repo, rewritten);
      overrides.push({ path, mode: "100644", type: "blob", sha: blobSha });
    }

    // Regenerated identity doc.
    const repoSpecSha = await this.createBlob(
      octokit,
      owner,
      repo,
      renderRepoSpec({
        nodeId: input.nodeId,
        chainId: input.chainId,
        daoContract: input.daoContract,
        pluginContract: input.pluginContract,
        signalContract: input.signalContract,
      })
    );
    overrides.push({
      path: ".cogni/repo-spec.yaml",
      mode: "100644",
      type: "blob",
      sha: repoSpecSha,
    });

    // Deletions (only emit sha:null for paths the template actually carries).
    for (const path of NODE_DELETE_PATHS) {
      const isDir = !presentPaths.has(path);
      const present = isDir
        ? [...presentPaths].some((p) => p.startsWith(`${path}/`))
        : true;
      if (!present) continue;
      overrides.push({
        path,
        mode: isDir ? "040000" : "100644",
        type: isDir ? "tree" : "blob",
        sha: null,
      });
    }

    const { data: nodeTree } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/trees",
      { owner, repo, base_tree: templateTreeSha, tree: overrides }
    );
    return nodeTree.sha;
  }

  /** Footprint single-file gens: fetch current main blob, apply the gen, create the new blob. */
  private async buildFootprintEntries(
    octokit: Octokit,
    owner: string,
    repo: string,
    input: OpenNodeAppPrInput,
    port: number,
    nodePort: number
  ): Promise<GitTreeEntry[]> {
    const { slug, nodeId } = input;
    const entries: GitTreeEntry[] = [];

    const addBlob = async (path: string, content: string): Promise<void> => {
      const sha = await this.createBlob(octokit, owner, repo, content);
      entries.push({ path, mode: "100644", type: "blob", sha });
    };

    // catalog/<slug>.yaml — brand-new file (no current content to thread).
    await addBlob(
      `infra/catalog/${slug}.yaml`,
      renderCatalog(slug, port, nodePort)
    );

    // overlays×3 + appsets×3 — per birth env.
    for (const env of NODE_BIRTH_ENVS) {
      const overlayPath = `infra/k8s/overlays/${env}/${slug}/kustomization.yaml`;
      const templateOverlay = await this.readFileOnMain(
        octokit,
        owner,
        repo,
        `infra/k8s/overlays/${env}/${TEMPLATE_SLUG}/kustomization.yaml`
      );
      await addBlob(
        overlayPath,
        renderOverlay(templateOverlay, slug, nodePort, port)
      );

      const appsetPath = `infra/k8s/argocd/${env}-applicationset.yaml`;
      const appset = await this.readFileOnMain(
        octokit,
        owner,
        repo,
        appsetPath
      );
      await addBlob(appsetPath, insertAppsetStanza(appset, slug, env));
    }

    // Caddyfile / ci.yaml / scheduler configmap / lockfile — single-file splices over main.
    const caddyfile = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      FOOTPRINT.caddyfile
    );
    await addBlob(
      FOOTPRINT.caddyfile,
      insertCaddyBlock(caddyfile, slug, nodePort)
    );

    const ciYaml = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      FOOTPRINT.ciYaml
    );
    await addBlob(FOOTPRINT.ciYaml, insertScopeFilter(ciYaml, slug));

    const configmap = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      FOOTPRINT.schedulerConfigmap
    );
    await addBlob(
      FOOTPRINT.schedulerConfigmap,
      insertSchedulerEndpoint(configmap, slug, nodeId)
    );

    const lockfile = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      FOOTPRINT.lockfile
    );
    await addBlob(FOOTPRINT.lockfile, insertLockfileImporters(lockfile, slug));

    return entries;
  }

  /** Resolve a nested tree-entry SHA by walking a `/`-delimited repo path from a root tree. */
  private async findTreeEntrySha(
    octokit: Octokit,
    owner: string,
    repo: string,
    rootTreeSha: string,
    path: string
  ): Promise<string | undefined> {
    const segments = path.split("/");
    let treeSha = rootTreeSha;
    for (let i = 0; i < segments.length; i++) {
      const { data: tree } = await octokit.request(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        { owner, repo, tree_sha: treeSha }
      );
      const match = tree.tree.find((e) => e.path === segments[i]);
      if (!match?.sha) return undefined;
      if (i === segments.length - 1) return match.sha;
      if (match.type !== "tree") return undefined;
      treeSha = match.sha;
    }
    return undefined;
  }

  /** Read a blob by SHA and decode its (base64) contents to UTF-8. */
  private async readBlob(
    octokit: Octokit,
    owner: string,
    repo: string,
    fileSha: string
  ): Promise<string> {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/blobs/{file_sha}",
      { owner, repo, file_sha: fileSha }
    );
    return Buffer.from(data.content, data.encoding as BufferEncoding).toString(
      "utf-8"
    );
  }

  /**
   * Read a file's UTF-8 contents from main. The contents API caps inline content
   * at 1MB (returns `encoding: "none"` + empty content above it) — pnpm-lock.yaml
   * is already 0.96MB, one dependency from silent truncation — so fall back to the
   * uncapped git/blobs endpoint via the blob SHA the metadata still returns.
   */
  private async readFileOnMain(
    octokit: Octokit,
    owner: string,
    repo: string,
    path: string
  ): Promise<string> {
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/contents/{path}",
      { owner, repo, path, ref: "main" }
    );
    if (Array.isArray(data) || data.type !== "file") {
      throw new Error(`openNodeAppPr: expected a file at ${path} on main`);
    }
    if (data.encoding === "base64" && data.content) {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }
    // Truncated (>1MB) — read the blob by SHA (git/blobs has no inline cap).
    return this.readBlob(octokit, owner, repo, data.sha);
  }

  /** Create a blob from UTF-8 content; return its SHA. */
  private async createBlob(
    octokit: Octokit,
    owner: string,
    repo: string,
    content: string
  ): Promise<string> {
    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/blobs",
      {
        owner,
        repo,
        content: Buffer.from(content, "utf-8").toString("base64"),
        encoding: "base64",
      }
    );
    return data.sha;
  }

  /** Create the branch ref at `sha`; on 422 (exists), fast-forward it via PATCH. */
  private async upsertRef(
    octokit: Octokit,
    owner: string,
    repo: string,
    branch: string,
    sha: string
  ): Promise<void> {
    try {
      await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 422) throw err;
      await octokit.request("PATCH /repos/{owner}/{repo}/git/refs/{ref}", {
        owner,
        repo,
        ref: `heads/${branch}`,
        sha,
        force: true,
      });
    }
  }

  /** Open the node-app PR; on 422 (one already exists for this head), return the existing one. */
  private async openOrFindPr(
    octokit: Octokit,
    owner: string,
    repo: string,
    slug: string,
    branch: string
  ): Promise<OpenNodeAppPrResult> {
    const title = `feat(node): bootstrap node-app for ${slug}`;
    const body =
      `Operator-authored node-birth PR for \`${slug}\` (App-direct via Git Data API).\n\n` +
      "Adds the node subtree (cloned from node-template, identity regenerated, secrets-catalog + " +
      "external-secrets stripped) plus the catalog entry, overlays×3, AppSet stanzas×3, Caddyfile, " +
      "ci.yaml scope filter, scheduler endpoints, and pnpm-lock importers.";
    try {
      const { data: pr } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls",
        { owner, repo, title, body, head: branch, base: "main" }
      );
      return { prNumber: pr.number, prUrl: pr.html_url };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 422) throw err;
      const { data: existing } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        { owner, repo, state: "open", head: `${owner}:${branch}`, per_page: 1 }
      );
      const pr = existing[0];
      if (!pr) {
        throw new Error(
          `Failed to open node-app PR and no open PR found for head ${branch}`
        );
      }
      return { prNumber: pr.number, prUrl: pr.html_url };
    }
  }

  private async getOctokit(owner: string, repo: string): Promise<Octokit> {
    const installationId = await this.resolveInstallationId(owner, repo);
    return new Octokit({
      authStrategy: createAppAuth,
      auth: {
        appId: this.config.appId,
        privateKey: this.config.privateKey,
        installationId,
      },
    });
  }

  private async resolveInstallationId(
    owner: string,
    repo: string
  ): Promise<number> {
    const { token } = await this.appAuth({ type: "app" });
    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/installation`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (!response.ok) {
      throw new Error(
        `GitHub App not installed on ${owner}/${repo} (HTTP ${response.status}). ` +
          `Install cogni-node-template on the target repo and retry.`
      );
    }
    const data = (await response.json()) as { id: number };
    return data.id;
  }
}
