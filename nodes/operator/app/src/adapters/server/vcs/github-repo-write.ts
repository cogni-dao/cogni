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
  insertAppsetKustomization,
  insertCaddyBlock,
  nextFreeNodePort,
  renderCatalog,
  renderGitmodules,
  renderNodeAppset,
  renderOverlay,
  renderRepoSpec,
} from "@/shared/node-app-scaffold/gens";

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

/**
 * Submodule-birth variant of {@link OpenNodeAppPrInput}: the node's ~1100 files live in an
 * already-minted standalone repo (the submodule target), not inline in the operator tree. The
 * operator PR pins that repo as a gitlink at `nodes/<slug>` + registers it in `.gitmodules`.
 * Minting the repo (GitHub generate-from-template) is the caller's responsibility — it requires a
 * standalone `node-template` template repo and is injected here as `nodeRepoUrl` + `nodeRepoHeadSha`.
 */
export interface OpenNodeSubmodulePrInput extends OpenNodeAppPrInput {
  /** Clone URL of the minted node repo, written into `.gitmodules`. */
  readonly nodeRepoUrl: string;
  /** Default-branch HEAD commit SHA of the minted node repo — the gitlink pin. */
  readonly nodeRepoHeadSha: string;
}

/** Input to {@link GitHubRepoWriter.generateFromTemplate}: mint a node repo from `node-template`. */
export interface GenerateFromTemplateInput {
  /** Org/user owning BOTH the `node-template` template and the new repo (e.g. `Cogni-DAO`). */
  readonly templateOwner: string;
  /** Owner the new node repo is created under (same org). */
  readonly owner: string;
  /** New repo name = node slug. */
  readonly slug: string;
  readonly nodeId: string;
  readonly chainId: number;
  readonly daoContract?: string;
  readonly pluginContract?: string;
  readonly signalContract?: string;
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
  argocdKustomization: "infra/k8s/argocd/kustomization.yaml",
} as const;

/**
 * Shared per-`(env, node)` ApplicationSet template — the SAME file `render-node-appset.sh` interpolates,
 * so the operator's emit is byte-exact to the renderer and the `--check` drift gate stays green (bug.0378).
 */
const APPSET_TEMPLATE_PATH = "scripts/ci/node-applicationset.yaml.tmpl";

// Node-content rename/delete (NODE_RENAME_PATHS / NODE_DELETE_PATHS) is gone with the inline
// `buildNodeSubtree`: a submodule node's files live in its own repo (minted via
// `generateFromTemplate`), and the seed already strips `.cogni/secrets-catalog.yaml` +
// `k8s/external-secrets` (bug.5086 Part D) — the operator never rewrites node-content blobs.

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
   * Mint a new node repo from the `node-template` template (generate-from-template) and set its
   * identity — commit the regenerated `.cogni/repo-spec.yaml` to the new repo's `main`. Returns the
   * clone URL + new HEAD SHA: the gitlink pin {@link openNodeSubmodulePr} consumes.
   *
   * Replaces the inline `openNodeAppPr` subtree-build: the node's ~1100 files now live in their own
   * repo, not inlined into the operator tree. Requires `node-template` marked a GitHub template repo
   * + the App installed org-wide (it must create the repo AND commit to it).
   */
  async generateFromTemplate(
    input: GenerateFromTemplateInput
  ): Promise<{ cloneUrl: string; headSha: string }> {
    const { templateOwner, owner, slug } = input;
    const tplOctokit = await this.getOctokit(templateOwner, TEMPLATE_SLUG);

    // Mint the repo — idempotent: a prior partial run (repo created, pin PR failed) re-runs cleanly
    // by reusing the existing repo instead of 422-ing on the duplicate name.
    let cloneUrl: string;
    try {
      const { data: created } = await tplOctokit.request(
        "POST /repos/{template_owner}/{template_repo}/generate",
        {
          template_owner: templateOwner,
          template_repo: TEMPLATE_SLUG,
          owner,
          name: slug,
          private: false,
          description: `Cogni node ${slug} — submodule of the operator monorepo`,
        }
      );
      cloneUrl = created.clone_url;
    } catch (err) {
      if ((err as { status?: number })?.status !== 422) throw err;
      const { data: existing } = await tplOctokit.request(
        "GET /repos/{owner}/{repo}",
        { owner, repo: slug }
      );
      cloneUrl = existing.clone_url;
    }

    // generate-from-template copies node-template's `.cogni/repo-spec.yaml` verbatim (its identity);
    // override it on the minted repo's main. The initial commit can lag the generate response, so
    // resolve main with a short retry before committing identity.
    const octokit = await this.getOctokit(owner, slug);
    let base: { baseCommitSha: string; baseTreeSha: string } | undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        base = await this.resolveMainBase(octokit, owner, slug);
        break;
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status !== 404 && status !== 409) throw err;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    if (!base) {
      throw new Error(
        `generateFromTemplate: ${owner}/${slug} main not ready after generate`
      );
    }
    const { baseCommitSha, baseTreeSha } = base;
    const repoSpecSha = await this.createBlob(
      octokit,
      owner,
      slug,
      renderRepoSpec({
        nodeId: input.nodeId,
        chainId: input.chainId,
        daoContract: input.daoContract,
        pluginContract: input.pluginContract,
        signalContract: input.signalContract,
      })
    );
    const { data: tree } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/trees",
      {
        owner,
        repo: slug,
        base_tree: baseTreeSha,
        tree: [
          {
            path: ".cogni/repo-spec.yaml",
            mode: "100644",
            type: "blob",
            sha: repoSpecSha,
          },
        ],
      }
    );
    const { data: commit } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/commits",
      {
        owner,
        repo: slug,
        message: `chore(node): set ${slug} identity`,
        tree: tree.sha,
        parents: [baseCommitSha],
      }
    );
    await this.upsertRef(octokit, owner, slug, "main", commit.sha);
    return { cloneUrl, headSha: commit.sha };
  }

  /**
   * Submodule-birth consumer of {@link generateFromTemplate}: instead of inlining the node's files into
   * the operator tree, pin an already-minted node repo as a git submodule at `nodes/<slug>` (a
   * `160000` gitlink) + register it in `.gitmodules`, alongside the same catalog/overlays/appsets/
   * Caddyfile/scheduler/scope-filter footprint MINUS the lockfile (a submodule node is not a workspace
   * member). The PR touches only operator-domain paths (bare gitlink + operator infra), so it passes
   * single-node-scope as ONE domain — SUBMODULE_GITLINK_IS_OPERATOR_PIN (spec: node-ci-cd-contract,
   * proven by single-node-scope fixture 19).
   *
   * Minting the node repo (GitHub generate-from-template — needs a standalone `node-template` template
   * repo) is the caller's job; its result is injected as `nodeRepoUrl` + `nodeRepoHeadSha`.
   */
  async openNodeSubmodulePr(
    input: OpenNodeSubmodulePrInput
  ): Promise<OpenNodeAppPrResult> {
    const { owner, repo, slug, nodeRepoUrl, nodeRepoHeadSha } = input;
    const octokit = await this.getOctokit(owner, repo);
    const { baseCommitSha, baseTreeSha } = await this.resolveMainBase(
      octokit,
      owner,
      repo
    );

    // .gitmodules — append the submodule stanza over current main (create if absent).
    const currentGitmodules = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      ".gitmodules"
    ).catch((err: unknown) => {
      // Only a missing .gitmodules is expected (first submodule). Never swallow real errors — a
      // transient read failure would otherwise overwrite an existing file, dropping its submodules.
      if ((err as { status?: number })?.status === 404) return null;
      throw err;
    });
    const gitmodulesSha = await this.createBlob(
      octokit,
      owner,
      repo,
      renderGitmodules(currentGitmodules, slug, nodeRepoUrl)
    );

    // Control-plane footprint gens (catalog, overlays, appsets, Caddyfile, scope-filter, scheduler).
    const nodePort = await this.allocateNodePort(
      octokit,
      owner,
      repo,
      baseTreeSha
    );
    const footprintEntries = await this.buildFootprintEntries(
      octokit,
      owner,
      repo,
      input,
      CONTAINER_PORT,
      nodePort
    );

    // The node is a 160000 GITLINK (the pin), not an inline subtree.
    return this.commitTreeAndOpenPr(octokit, owner, repo, slug, {
      baseCommitSha,
      baseTreeSha,
      entries: [
        {
          path: `nodes/${slug}`,
          mode: "160000",
          type: "commit",
          sha: nodeRepoHeadSha,
        },
        {
          path: ".gitmodules",
          mode: "100644",
          type: "blob",
          sha: gitmodulesSha,
        },
        ...footprintEntries,
      ],
      message: `feat(node): pin ${slug} as a submodule`,
      branch: `cogni-operator/node-submodule-${slug}`,
    });
  }

  /** Resolve `heads/main` → its commit + root-tree SHAs (the parent for a node-birth commit). */
  private async resolveMainBase(
    octokit: Octokit,
    owner: string,
    repo: string
  ): Promise<{ baseCommitSha: string; baseTreeSha: string }> {
    const { data: ref } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      { owner, repo, ref: "heads/main" }
    );
    const baseCommitSha = ref.object.sha;
    const { data: baseCommit } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { owner, repo, commit_sha: baseCommitSha }
    );
    return { baseCommitSha, baseTreeSha: baseCommit.tree.sha };
  }

  /** Build the final tree atop `base_tree`, commit it, upsert the branch (idempotent), open/find the PR. */
  private async commitTreeAndOpenPr(
    octokit: Octokit,
    owner: string,
    repo: string,
    slug: string,
    args: {
      baseCommitSha: string;
      baseTreeSha: string;
      entries: GitTreeEntry[];
      message: string;
      branch: string;
    }
  ): Promise<OpenNodeAppPrResult> {
    const { data: finalTree } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/trees",
      { owner, repo, base_tree: args.baseTreeSha, tree: args.entries }
    );
    const { data: commit } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/commits",
      {
        owner,
        repo,
        message: args.message,
        tree: finalTree.sha,
        parents: [args.baseCommitSha],
      }
    );
    await this.upsertRef(octokit, owner, repo, args.branch, commit.sha);
    return this.openOrFindPr(octokit, owner, repo, slug, args.branch);
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
      throw new Error("allocateNodePort: infra/catalog tree not found on main");
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

  /** Footprint single-file gens: fetch current main blob, apply the gen, create the new blob. */
  private async buildFootprintEntries(
    octokit: Octokit,
    owner: string,
    repo: string,
    input: OpenNodeAppPrInput | OpenNodeSubmodulePrInput,
    port: number,
    nodePort: number
  ): Promise<GitTreeEntry[]> {
    const { slug } = input;
    const entries: GitTreeEntry[] = [];

    const addBlob = async (path: string, content: string): Promise<void> => {
      const sha = await this.createBlob(octokit, owner, repo, content);
      entries.push({ path, mode: "100644", type: "blob", sha });
    };

    // catalog/<slug>.yaml — brand-new file (no current content to thread).
    const catalogInput =
      "nodeRepoUrl" in input ? { sourceRepo: input.nodeRepoUrl } : {};
    await addBlob(
      `infra/catalog/${slug}.yaml`,
      renderCatalog(slug, port, nodePort, catalogInput)
    );

    // overlays×3 — per birth env.
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
    }

    // per-node AppSets×3 — one ApplicationSet object per (env, slug) for structural LANE_ISOLATION
    // (bug.0378). New files from the shared template (byte-exact to render-node-appset.sh), then folded
    // into the bootstrap kustomization's GENERATED block so the unit-job drift gate stays green.
    const appsetTemplate = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      APPSET_TEMPLATE_PATH
    );
    for (const env of NODE_BIRTH_ENVS) {
      await addBlob(
        `infra/k8s/argocd/${env}-${slug}-applicationset.yaml`,
        renderNodeAppset(appsetTemplate, slug, env)
      );
    }
    const argocdKustomization = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      FOOTPRINT.argocdKustomization
    );
    await addBlob(
      FOOTPRINT.argocdKustomization,
      insertAppsetKustomization(argocdKustomization, slug, NODE_BIRTH_ENVS)
    );

    // Caddyfile / ci.yaml / lockfile — single-file splices over main.
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

    // No ci.yaml scope-filter splice: a submodule node carries NO single-node-scope
    // filter (SUBMODULE_GITLINK_IS_OPERATOR_PIN). Emitting a `nodes/<slug>/**` filter
    // would make picomatch's globstar match the bare gitlink `nodes/<slug>`, so the pin
    // misclassifies as node-domain and single-node-scope false-fails. With no filter the
    // gitlink falls to operator's `**`. Mirrors render-scope-filters.sh's submodule skip.

    // No scheduler-worker endpoint splice yet: a submodule node's identity lives in the
    // minted repo's `.cogni/repo-spec.yaml`, not in the parent checkout. The parent
    // renderer skips `.gitmodules` nodes until the catalog -> NodeRegistry metadata
    // projection lands, so inserting this endpoint here would make the generated PR fail
    // the scheduler endpoint drift check.

    // No pnpm-lock.yaml: a submodule node is not a workspace member of the operator monorepo — its
    // packages resolve in its own repo + lockfile. (The single biggest chunk of inline-only tax.)

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
      throw new Error(`readFileOnMain: expected a file at ${path} on main`);
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
      "Pins the minted node repo as a submodule and adds the operator-owned deployment footprint: " +
      "catalog entry, overlays×3, AppSet stanzas×3, and edge route. The node source, CI, review " +
      "rules, and image build live in the minted node repo.";
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
