// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-repo-write`
 * Purpose: Operator-only helper that mints node repos, commits files, and opens pull requests via the GitHub App.
 * Scope: Thin Octokit calls behind node formation, catalog source_sha pin, and candidate-flight prep.
 *   Does not belong in `VcsCapability` because that capability is shared with poly/resy/node-template stubs
 *   and these write ops are operator-only.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED: caller must verify the app is installed on the target repo; we surface a
 *     clear error if not. Installation must cover the node repo (private-safe).
 *   - NODE_FORMATION_TREE: a publish creates one reviewable tree — catalog row (with source_sha pin),
 *     overlay, AppSet, edge-route, and ExternalSecret shape. No gitlink, no .gitmodules
 *     (spec.node-submodule-retirement).
 *   - PR_AGAINST_MAIN: opens node-formation PRs against `main`; never force-pushes review branches.
 * Side-effects: IO (GitHub REST API)
 * Links: docs/spec/node-formation.md, task.0370, task.5083
 * @internal
 */

import { extractNodeId, parseRepoSpec } from "@cogni/repo-spec";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/core";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import type {
  CandidateFlightDispatchResult,
  NodePreviewPromoteResult,
  OperatorDeployPlanePort,
  PreparedNodeRefCandidateFlight,
  PrepareNodeRefCandidateFlightInput,
  PromoteNodeToPreviewInput,
} from "@/ports";
import {
  insertAppsetKustomization,
  insertCaddyBlock,
  insertSchedulerEndpoint,
  NODE_FORMATION_ENVS,
  nextFreeNodePort,
  renderCatalog,
  renderNodeAppset,
  renderNodeExternalSecret,
  renderNodeExternalSecretKustomization,
  renderOverlay,
  renderRepoSpec,
} from "@/shared/node-app-scaffold/gens";
import type { NodeKnowledgeRemote } from "@/shared/node-app-scaffold/knowledge-remote";

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
  readonly knowledgeRemote?: NodeKnowledgeRemote;
}

export interface OpenNodeAppPrResult {
  readonly prNumber: number;
  readonly prUrl: string;
}

/**
 * Remote-source node registration variant of {@link OpenNodeAppPrInput}: the node's files live in an
 * already-minted standalone repo, not inline in the operator tree. The operator PR registers it via
 * its catalog row (`source_repo` + `source_sha` pin) + operator footprint — no gitlink, no .gitmodules
 * (spec.node-submodule-retirement). Minting the repo (GitHub fork of node-template) is the caller's
 * responsibility, injected here as `nodeRepoUrl` + `nodeRepoHeadSha`.
 */
export interface OpenNodeSubmodulePrInput extends OpenNodeAppPrInput {
  /** Clone URL of the minted node repo → catalog `source_repo`. */
  readonly nodeRepoUrl: string;
  /** Default-branch HEAD commit SHA of the minted node repo → catalog `source_sha` pin. */
  readonly nodeRepoHeadSha: string;
}

export interface EnsureNodeSubmodulePinInput {
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
  readonly nodeRepoUrl: string;
  readonly nodeRepoHeadSha: string;
}

export type EnsureNodeSubmodulePinResult =
  | {
      readonly status: "already_pinned";
      readonly currentSha: string;
    }
  | {
      readonly status: "pin_pr_opened";
      readonly currentSha: string | null;
      readonly prNumber: number;
      readonly prUrl: string;
      readonly parentHeadSha: string;
    };

export interface PackageImageTagExistsInput {
  readonly owner: string;
  readonly repo: string;
  readonly imageRepository: string;
  readonly tag: string;
}

type PackageImageTagStatus =
  | { readonly status: "ready" }
  | { readonly status: "missing" };

/** Input to {@link GitHubRepoWriter.forkFromTemplate}: mint a node repo from `node-template`. */
export interface ForkFromTemplateInput {
  /** Org/user owning the `node-template` source repo (e.g. `Cogni-DAO`). */
  readonly templateOwner: string;
  /** Owner the new node fork is created under. */
  readonly owner: string;
  /** New repo name = node slug. */
  readonly slug: string;
  readonly nodeId: string;
  readonly chainId: number;
  readonly daoContract?: string;
  readonly pluginContract?: string;
  readonly signalContract?: string;
  readonly knowledgeRemote?: NodeKnowledgeRemote;
}

/** One entry in a `POST /git/trees` payload; `sha: null` deletes the path from `base_tree`. */
interface GitTreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755" | "040000" | "160000" | "120000";
  readonly type: "blob" | "tree" | "commit";
  readonly sha: string | null;
}

const TEMPLATE_SLUG = "node-template";
const CONTAINER_PORT = 3200;

/** Footprint files edited in-place by the node-formation PR (single-file gens over current main). */
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
const SOURCE_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;
const NODE_REPO_REQUIRED_WORKFLOWS = [
  ".github/workflows/ci.yaml",
  ".github/workflows/pr-build.yml",
  ".github/workflows/pr-lint.yaml",
] as const;

const CatalogEntrySchema = z.object({
  name: z.string(),
  type: z.literal("node"),
  path_prefix: z.string(),
  source_repo: z.string().url(),
  image_repository: z
    .string()
    .regex(/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/),
});

function parseGhcrImageRepository(imageRepository: string): {
  owner: string;
  packageName: string;
} {
  const match = /^ghcr\.io\/([^/]+)\/([^/]+)$/.exec(imageRepository);
  const [, owner, packageName] = match ?? [];
  if (!owner || !packageName) {
    throw new Error(
      `image_repository must be ghcr.io/<owner>/<image>: ${imageRepository}`
    );
  }
  return { owner, packageName };
}

function parseGithubRepoUrl(value: string): { owner: string; repo: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "github.com") {
    throw deployPlaneError(
      "invalid_source_repo",
      `source_repo must be a GitHub HTTPS URL: ${value}`,
      409
    );
  }
  const [owner, repoWithSuffix, ...extra] = url.pathname
    .split("/")
    .filter(Boolean);
  const repo = repoWithSuffix?.replace(/\.git$/, "");
  if (!owner || !repo || extra.length > 0) {
    throw deployPlaneError(
      "invalid_source_repo",
      "source_repo must be https://github.com/<owner>/<repo>",
      409
    );
  }
  return { owner, repo };
}

function deployPlaneError(
  code: string,
  message: string,
  status: number
): Error & { readonly code: string; readonly status: number } {
  return Object.assign(new Error(message), { code, status });
}

// Node-content rename/delete (NODE_RENAME_PATHS / NODE_DELETE_PATHS) is gone with the inline
// `buildNodeSubtree`: a submodule node's app files live in its own repo (minted via
// `forkFromTemplate`). The operator writes only node identity plus the ESO-first leaf files that
// must be visible after the repo is mounted as `nodes/<slug>`.

export class GitHubRepoWriter implements OperatorDeployPlanePort {
  private readonly config: GitHubRepoWriterConfig;
  private readonly appAuth: ReturnType<typeof createAppAuth>;

  constructor(config: GitHubRepoWriterConfig) {
    this.config = config;
    this.appAuth = createAppAuth({
      appId: config.appId,
      privateKey: config.privateKey,
    });
  }

  async prepareNodeRefCandidateFlight(
    input: PrepareNodeRefCandidateFlightInput
  ): Promise<PreparedNodeRefCandidateFlight> {
    const { parentOwner, parentRepo, nodeId, slug, sourceSha } = input;
    if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
      throw deployPlaneError(
        "invalid_source_sha",
        "sourceSha must be a 40-character hex SHA",
        400
      );
    }

    const catalogText = await this.fetchFileText({
      owner: parentOwner,
      repo: parentRepo,
      path: `infra/catalog/${slug}.yaml`,
      ref: "main",
    });
    if (!catalogText) {
      throw deployPlaneError(
        "catalog_missing",
        `node catalog entry not found for ${slug}`,
        404
      );
    }
    const catalog = CatalogEntrySchema.safeParse(parseYaml(catalogText));
    if (!catalog.success || catalog.data.name !== slug) {
      throw deployPlaneError(
        "invalid_catalog",
        `invalid submodule node catalog entry for ${slug}`,
        409
      );
    }
    if (catalog.data.path_prefix !== `nodes/${slug}/`) {
      throw deployPlaneError(
        "catalog_slug_mismatch",
        `catalog path_prefix does not match nodes/${slug}/`,
        409
      );
    }

    const sourceRepo = parseGithubRepoUrl(catalog.data.source_repo);
    const imageRepo = parseGhcrImageRepository(catalog.data.image_repository);
    if (
      imageRepo.owner.toLowerCase() !== sourceRepo.owner.toLowerCase() ||
      imageRepo.packageName.toLowerCase() !== sourceRepo.repo.toLowerCase()
    ) {
      throw deployPlaneError(
        "image_repository_mismatch",
        `catalog image_repository must match source_repo: expected ghcr.io/${sourceRepo.owner.toLowerCase()}/${sourceRepo.repo.toLowerCase()}`,
        409
      );
    }

    const sourceExists = await this.commitExists({
      owner: sourceRepo.owner,
      repo: sourceRepo.repo,
      ref: sourceSha,
    });
    if (!sourceExists) {
      throw deployPlaneError(
        "source_missing",
        `sourceSha not found in ${catalog.data.source_repo}`,
        422
      );
    }

    const repoSpecText = await this.fetchFileText({
      owner: sourceRepo.owner,
      repo: sourceRepo.repo,
      path: ".cogni/repo-spec.yaml",
      ref: sourceSha,
    });
    if (!repoSpecText) {
      throw deployPlaneError(
        "repo_spec_missing",
        "node repo-spec not found at sourceSha",
        422
      );
    }

    let actualNodeId: string;
    try {
      actualNodeId = extractNodeId(parseRepoSpec(repoSpecText));
    } catch {
      throw deployPlaneError(
        "invalid_repo_spec",
        "node repo-spec is invalid at sourceSha",
        422
      );
    }
    if (actualNodeId !== nodeId) {
      throw deployPlaneError(
        "node_id_mismatch",
        `node repo-spec identity mismatch: expected ${nodeId}, got ${actualNodeId}`,
        422
      );
    }

    const parentPin = await this.ensureCatalogSourceSha({
      owner: parentOwner,
      repo: parentRepo,
      slug,
      nodeRepoUrl: catalog.data.source_repo,
      nodeRepoHeadSha: sourceSha,
    });

    return {
      nodeId,
      slug,
      sourceSha,
      sourceRepo: catalog.data.source_repo,
      image: `${catalog.data.image_repository}:sha-${sourceSha}`,
      parentPin,
    };
  }

  /**
   * Node-merge → preview tie (PREVIEW_VIA_FLIGHT_PREVIEW). Bumps the parent catalog
   * `source_sha` pin to the merged node SHA and enables auto-merge on the one-line PR.
   * Landing that PR on parent main is the flight-preview.yml trigger — we never dispatch
   * promote-and-deploy here. Image existence is NOT gated in-app: the GitHub Packages API
   * false-negatives on private node images (git-app-expert), so flight-preview's own
   * "no images found" hard-fail is the loud backstop, not a silent skip.
   */
  async promoteNodeToPreview(
    input: PromoteNodeToPreviewInput
  ): Promise<NodePreviewPromoteResult> {
    const { parentOwner, parentRepo, slug, sourceSha } = input;
    if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
      throw deployPlaneError(
        "invalid_source_sha",
        "sourceSha must be a 40-character hex SHA",
        400
      );
    }

    const catalogText = await this.fetchFileText({
      owner: parentOwner,
      repo: parentRepo,
      path: `infra/catalog/${slug}.yaml`,
      ref: "main",
    });
    if (!catalogText) {
      throw deployPlaneError(
        "catalog_missing",
        `node catalog entry not found for ${slug}`,
        404
      );
    }
    const catalog = CatalogEntrySchema.safeParse(parseYaml(catalogText));
    if (!catalog.success || catalog.data.name !== slug) {
      throw deployPlaneError(
        "invalid_catalog",
        `invalid node catalog entry for ${slug}`,
        409
      );
    }

    const pin = await this.ensureCatalogSourceSha({
      owner: parentOwner,
      repo: parentRepo,
      slug,
      nodeRepoUrl: catalog.data.source_repo,
      nodeRepoHeadSha: sourceSha,
    });
    if (pin.status === "already_pinned") {
      return { status: "already_pinned", currentSha: pin.currentSha };
    }
    const autoMergeEnabled = await this.enableAutoMerge(
      parentOwner,
      parentRepo,
      pin.prNumber
    );
    return {
      status: "pin_pr_opened",
      prNumber: pin.prNumber,
      prUrl: pin.prUrl,
      currentSha: pin.currentSha,
      autoMergeEnabled,
    };
  }

  async dispatchNodeRefCandidateFlight(input: {
    owner: string;
    repo: string;
    slug: string;
    sourceSha: string;
  }): Promise<CandidateFlightDispatchResult> {
    const octokit = await this.getOctokit(input.owner, input.repo);
    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: input.owner,
        repo: input.repo,
        workflow_id: "candidate-flight.yml",
        ref: "main",
        inputs: {
          node_slug: input.slug,
          source_sha: input.sourceSha,
        },
        request: { signal: AbortSignal.timeout(15_000) },
      }
    );
    return {
      dispatched: true,
      workflowUrl: `https://github.com/${input.owner}/${input.repo}/actions/workflows/candidate-flight.yml`,
      message: `Candidate flight dispatched for ${input.slug}@${input.sourceSha.slice(0, 8)}.`,
    };
  }

  async dispatchNodePromote(input: {
    owner: string;
    repo: string;
    env: string;
    slug: string;
    sourceSha?: string;
  }): Promise<CandidateFlightDispatchResult> {
    const octokit = await this.getOctokit(input.owner, input.repo);
    const inputs: Record<string, string> = {
      environment: input.env,
      nodes: input.slug,
      // APP_PROMOTE_IS_NO_INFRA: the agent-facing promote endpoint reconciles the
      // app digest only — orthogonal to substrate, mirroring candidate-flight (no
      // deploy-infra job). Set explicitly, not via the workflow default, so the
      // contract can't silently flip. Compose/secret/edge changes go through a
      // deliberate infra lever, never an app promotion.
      skip_infra: "true",
    };
    // Omit source_sha for catalog-pin nodes (CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN);
    // never pass a child SHA as the parent checkout ref.
    if (input.sourceSha) inputs.source_sha = input.sourceSha;
    // workflow_dispatch is fire-and-forget (GitHub queues + returns 204); bound it
    // so a slow/stuck GitHub call can't hang the promote route with no deadline.
    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: input.owner,
        repo: input.repo,
        workflow_id: "promote-and-deploy.yml",
        ref: "main",
        inputs,
        request: { signal: AbortSignal.timeout(15_000) },
      }
    );
    return {
      dispatched: true,
      workflowUrl: `https://github.com/${input.owner}/${input.repo}/actions/workflows/promote-and-deploy.yml`,
      message: `Promote dispatched: ${input.slug} → ${input.env}.`,
    };
  }

  async commitExists(input: {
    owner: string;
    repo: string;
    ref: string;
  }): Promise<boolean> {
    const octokit = await this.getOctokit(input.owner, input.repo);
    try {
      await octokit.request("GET /repos/{owner}/{repo}/commits/{ref}", {
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
      });
      return true;
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return false;
      throw error;
    }
  }

  async fetchFileText(input: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null> {
    const octokit = await this.getOctokit(input.owner, input.repo);
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: input.owner,
          repo: input.repo,
          path: input.path,
          ref: input.ref ?? "main",
        }
      );
      if (Array.isArray(data) || data.type !== "file") return null;
      if (data.encoding === "base64" && data.content) {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      return this.readBlob(octokit, input.owner, input.repo, data.sha);
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return null;
      throw error;
    }
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
   * Mint a new node repo as a named fork of `node-template` and set its
   * identity — commit the regenerated `.cogni/repo-spec.yaml` to the new repo's `main`. Returns the
   * clone URL + new HEAD SHA: the gitlink pin {@link openNodeSubmodulePr} consumes.
   *
   * Replaces the inline `openNodeAppPr` subtree-build: the node's ~1100 files now live in their own
   * repo, not inlined into the operator tree. Uses GitHub forks instead of template generation so
   * spawned nodes share git history with `node-template` and can merge upstream changes normally.
   */
  async forkFromTemplate(
    input: ForkFromTemplateInput
  ): Promise<{ cloneUrl: string; headSha: string }> {
    const { templateOwner, owner, slug } = input;
    const tplOctokit = await this.getOctokit(templateOwner, TEMPLATE_SLUG);

    // Mint the repo as a named fork — idempotent: a prior partial run (fork created, pin PR failed)
    // re-runs cleanly by reusing the existing matching fork instead of 422-ing on the duplicate name.
    let cloneUrl: string;
    try {
      const { data: created } = await tplOctokit.request(
        "POST /repos/{owner}/{repo}/forks",
        {
          owner: templateOwner,
          repo: TEMPLATE_SLUG,
          organization: owner,
          name: slug,
          default_branch_only: true,
        }
      );
      cloneUrl = created.clone_url;
    } catch (err) {
      if ((err as { status?: number })?.status !== 422) throw err;
      const existingRepo = await tplOctokit.request(
        "GET /repos/{owner}/{repo}",
        { owner, repo: slug }
      );
      this.assertExistingTemplateFork(
        existingRepo.data,
        templateOwner,
        TEMPLATE_SLUG,
        slug
      );
      cloneUrl = existingRepo.data.clone_url;
    }

    // Forking is async. Resolve main with a short retry before committing identity.
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
        `forkFromTemplate: ${owner}/${slug} main not ready after fork`
      );
    }
    await this.ensureActionsEnabled(octokit, owner, slug);
    const { baseCommitSha, baseTreeSha } = base;
    const repoSpecSha = await this.createBlob(
      octokit,
      owner,
      slug,
      renderRepoSpec({
        slug,
        repoOwner: owner,
        nodeId: input.nodeId,
        chainId: input.chainId,
        daoContract: input.daoContract,
        pluginContract: input.pluginContract,
        signalContract: input.signalContract,
        knowledgeRemote: input.knowledgeRemote,
      })
    );
    const externalSecretEntries: GitTreeEntry[] = [];
    for (const env of NODE_FORMATION_ENVS) {
      externalSecretEntries.push(
        {
          path: `k8s/external-secrets/${env}/external-secret.yaml`,
          mode: "100644",
          type: "blob",
          sha: await this.createBlob(
            octokit,
            owner,
            slug,
            renderNodeExternalSecret(slug, env)
          ),
        },
        {
          path: `k8s/external-secrets/${env}/kustomization.yaml`,
          mode: "100644",
          type: "blob",
          sha: await this.createBlob(
            octokit,
            owner,
            slug,
            renderNodeExternalSecretKustomization()
          ),
        }
      );
    }
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
          ...externalSecretEntries,
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
   * Submodule-birth consumer of {@link forkFromTemplate}: instead of inlining the node's files into
   * the operator tree, pin an already-minted node repo as a git submodule at `nodes/<slug>` (a
   * `160000` gitlink) + register it in `.gitmodules`, alongside the same catalog/overlays/appsets/
   * Caddyfile/scheduler/scope-filter footprint MINUS the lockfile (a submodule node is not a workspace
   * member). The PR touches only operator-domain paths (bare gitlink + operator infra), so it passes
   * single-node-scope as ONE domain — SUBMODULE_GITLINK_IS_OPERATOR_PIN (spec: node-ci-cd-contract,
   * proven by single-node-scope fixture 19).
   *
   * Minting the node repo (GitHub fork of the standalone `node-template` repo) is the caller's job;
   * its result is injected as `nodeRepoUrl` + `nodeRepoHeadSha`.
   */
  async openNodeSubmodulePr(
    input: OpenNodeSubmodulePrInput
  ): Promise<OpenNodeAppPrResult> {
    const { owner, repo, slug } = input;
    const octokit = await this.getOctokit(owner, repo);
    const { baseCommitSha, baseTreeSha } = await this.resolveMainBase(
      octokit,
      owner,
      repo
    );

    // Control-plane footprint gens (catalog w/ source_sha pin, overlays, appsets, Caddyfile,
    // scheduler). No gitlink, no .gitmodules — the node is registered by its catalog row +
    // source_sha pin, not a submodule checkout (spec.node-submodule-retirement).
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

    return this.commitTreeAndOpenPr(octokit, owner, repo, slug, {
      baseCommitSha,
      baseTreeSha,
      entries: footprintEntries,
      message: `feat(node): register ${slug}`,
      branch: `cogni-operator/node-register-${slug}`,
    });
  }

  /**
   * Pin a remote-source node for flight by bumping its catalog `source_sha` field
   * (CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN) — no gitlink, no `.gitmodules`. Opens a
   * one-line catalog PR when the pin differs; idempotent via {@link commitFileAndOpenPr}.
   */
  async ensureCatalogSourceSha(
    input: EnsureNodeSubmodulePinInput
  ): Promise<EnsureNodeSubmodulePinResult> {
    const { owner, repo, slug, nodeRepoHeadSha } = input;
    const path = `infra/catalog/${slug}.yaml`;
    const current = await this.fetchFileText({
      owner,
      repo,
      path,
      ref: "main",
    });
    if (!current) {
      throw deployPlaneError(
        "catalog_missing",
        `node catalog entry not found for ${slug}`,
        404
      );
    }
    const currentSha =
      /^source_sha:\s*([0-9a-fA-F]{40})\s*$/m.exec(current)?.[1] ?? null;
    if (currentSha === nodeRepoHeadSha) {
      return { status: "already_pinned", currentSha };
    }
    const updated = currentSha
      ? current.replace(
          /^source_sha:\s*[0-9a-fA-F]{40}\s*$/m,
          `source_sha: ${nodeRepoHeadSha}`
        )
      : current.replace(
          /^(image_repository:.*\n)/m,
          `$1source_sha: ${nodeRepoHeadSha}\n`
        );
    const branch = `cogni-operator/node-pin-${slug}-${nodeRepoHeadSha.slice(0, 8)}`;
    const pr = await this.commitFileAndOpenPr({
      owner,
      repo,
      baseRef: "main",
      headBranch: branch,
      path,
      content: updated,
      commitMessage: `chore(node): pin ${slug} at ${nodeRepoHeadSha.slice(0, 8)}`,
      prTitle: `chore(node): pin ${slug} at ${nodeRepoHeadSha.slice(0, 8)}`,
      prBody: `Bumps catalog \`source_sha\` for \`${slug}\` to \`${nodeRepoHeadSha}\` before node-ref flight (CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN).`,
    });
    return {
      status: "pin_pr_opened",
      currentSha,
      prNumber: pr.prNumber,
      prUrl: pr.prUrl,
      parentHeadSha: pr.headSha,
    };
  }

  async packageImageTagExists(
    input: PackageImageTagExistsInput
  ): Promise<boolean> {
    return (await this.packageImageTagStatus(input)).status === "ready";
  }

  async packageImageTagStatus(
    input: PackageImageTagExistsInput
  ): Promise<PackageImageTagStatus> {
    const parsed = parseGhcrImageRepository(input.imageRepository);
    const octokit = await this.getOctokit(input.owner, input.repo);

    try {
      await octokit.request(
        "GET /orgs/{org}/packages/{package_type}/{package_name}",
        {
          org: parsed.owner,
          package_type: "container",
          package_name: parsed.packageName,
        }
      );

      for (let page = 1; page <= 10; page += 1) {
        const { data } = await octokit.request(
          "GET /orgs/{org}/packages/{package_type}/{package_name}/versions",
          {
            org: parsed.owner,
            package_type: "container",
            package_name: parsed.packageName,
            per_page: 100,
            page,
          }
        );
        if (
          data.some((version) =>
            version.metadata?.container?.tags?.includes(input.tag)
          )
        ) {
          return { status: "ready" };
        }
        if (data.length < 100) return { status: "missing" };
      }
      return { status: "missing" };
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status === 403 || status === 404) return { status: "missing" };
      throw err;
    }
  }

  /**
   * Count wizard-deployed nodes in the network = `infra/catalog/*.yaml` entries with `type: node`
   * AND a `source_repo` (remote-source / wizard-born), read from the deployment parent repo on `main`.
   * This is the post-#1647 deployment SSOT for the merge-authority capacity gate: `.gitmodules` was
   * retired (CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN), so the old `.gitmodules` count is always 0
   * (fail-open). Mirrors {@link allocateNodePort}'s catalog tree-walk.
   */
  async countDeployedWizardNodes(input: {
    owner: string;
    repo: string;
  }): Promise<number> {
    const { owner, repo } = input;
    const octokit = await this.getOctokit(owner, repo);
    const { baseTreeSha } = await this.resolveMainBase(octokit, owner, repo);
    const catalogTreeSha = await this.findTreeEntrySha(
      octokit,
      owner,
      repo,
      baseTreeSha,
      "infra/catalog"
    );
    if (!catalogTreeSha) return 0;
    const { data: catalogTree } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: catalogTreeSha }
    );
    const yamlBlobs = catalogTree.tree.filter(
      (e) => e.type === "blob" && (e.path ?? "").endsWith(".yaml")
    );
    let count = 0;
    for (const entry of yamlBlobs) {
      if (!entry.sha) continue;
      const text = await this.readBlob(octokit, owner, repo, entry.sha);
      if (
        /^type:\s*node\s*$/m.test(text) &&
        /^source_repo:\s*\S+/m.test(text)
      ) {
        count += 1;
      }
    }
    return count;
  }

  /**
   * Enable GitHub auto-merge (SQUASH) on a parent PR. `main` has no merge queue, so auto-merge
   * lands the PR the moment its required checks (unit/component/static/manifest) pass — and that
   * push to `main` fires flight-preview.yml. Non-fatal: if the repo disallows auto-merge or the PR
   * has no pending checks to gate on, GitHub rejects the mutation; we leave the PR open (a human
   * lands it) and report false.
   */
  private async enableAutoMerge(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<boolean> {
    const octokit = await this.getOctokit(owner, repo);
    const { data: pr } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      { owner, repo, pull_number: prNumber }
    );
    try {
      await octokit.graphql(
        `mutation($pullRequestId: ID!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $pullRequestId, mergeMethod: SQUASH }) {
            pullRequest { number }
          }
        }`,
        { pullRequestId: pr.node_id }
      );
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve `heads/main` → its commit + root-tree SHAs (the parent for a node-formation commit). */
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

  private assertExistingTemplateFork(
    repo: {
      readonly full_name?: string;
      readonly fork?: boolean;
      readonly parent?: { readonly full_name?: string };
      readonly source?: { readonly full_name?: string };
    },
    templateOwner: string,
    templateRepo: string,
    slug: string
  ): void {
    const expectedParent = `${templateOwner}/${templateRepo}`;
    const actualParents = [repo.parent?.full_name, repo.source?.full_name];
    if (
      repo.fork &&
      actualParents.some(
        (fullName) =>
          typeof fullName === "string" &&
          fullName.toLowerCase() === expectedParent.toLowerCase()
      )
    ) {
      return;
    }
    throw new Error(
      `forkFromTemplate: ${repo.full_name ?? slug} already exists but is not a fork of ${expectedParent}`
    );
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
    // Remote-source node: project node_id (drift-gated mirror of the minted repo-spec)
    // and source_sha (the deploy pin replacing the gitlink) into the catalog so parent
    // renderers + the deploy plane resolve identity + deploy SHA from metadata alone.
    const catalogInput =
      "nodeRepoUrl" in input
        ? {
            sourceRepo: input.nodeRepoUrl,
            nodeId: input.nodeId,
            sourceSha: input.nodeRepoHeadSha,
          }
        : {};
    await addBlob(
      `infra/catalog/${slug}.yaml`,
      renderCatalog(slug, port, nodePort, catalogInput)
    );

    // overlays×3 — per birth env.
    for (const env of NODE_FORMATION_ENVS) {
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
    for (const env of NODE_FORMATION_ENVS) {
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
      insertAppsetKustomization(argocdKustomization, slug, NODE_FORMATION_ENVS)
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

    // Scheduler-worker endpoint splice: the catalog now carries this submodule node's
    // node_id projection (above), and the routing renderer enumerates every catalog
    // type:node (is_built_by_this_repo lifted from the routing CSVs). So splice this node
    // into the base configmap from the projected node_id — keeping it drift-clean with the
    // catalog, born-green so chat/completions works on first flight (verify-scheduler-endpoints).
    if ("nodeRepoUrl" in input) {
      const schedulerConfigmapPath =
        "infra/k8s/base/scheduler-worker/configmap.yaml";
      const currentConfigmap = await this.fetchFileText({
        owner,
        repo,
        path: schedulerConfigmapPath,
        ref: "main",
      });
      if (currentConfigmap) {
        await addBlob(
          schedulerConfigmapPath,
          insertSchedulerEndpoint(currentConfigmap, slug, input.nodeId)
        );
      }
    }

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

  private async ensureActionsEnabled(
    octokit: Octokit,
    owner: string,
    repo: string
  ): Promise<void> {
    await octokit.request("PUT /repos/{owner}/{repo}/actions/permissions", {
      owner,
      repo,
      enabled: true,
      allowed_actions: "all",
    });
    try {
      await octokit.request(
        "PUT /repos/{owner}/{repo}/actions/permissions/workflow",
        {
          owner,
          repo,
          default_workflow_permissions: "write",
          can_approve_pull_request_reviews: false,
        }
      );
    } catch (err) {
      const status = (err as { status?: number })?.status;
      if (status !== 409) throw err;
    }
    await this.waitForNodeRepoWorkflows(octokit, owner, repo);
  }

  private async waitForNodeRepoWorkflows(
    octokit: Octokit,
    owner: string,
    repo: string
  ): Promise<void> {
    for (let attempt = 0; attempt < 12; attempt++) {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/actions/workflows",
        { owner, repo, per_page: 100 }
      );
      const activePaths = new Set(
        (
          data as {
            readonly workflows?: ReadonlyArray<{
              readonly path?: string;
              readonly state?: string;
            }>;
          }
        ).workflows
          ?.filter((workflow) => workflow.state === "active")
          .map((workflow) => workflow.path) ?? []
      );
      if (NODE_REPO_REQUIRED_WORKFLOWS.every((path) => activePaths.has(path))) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `forkFromTemplate: ${owner}/${repo} workflows not active after enabling Actions`
    );
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
      `Operator-authored node-formation PR for \`${slug}\` (App-direct via Git Data API).\n\n` +
      "Pins the minted node repo as a submodule and adds the operator-owned deployment footprint: " +
      "catalog entry, overlays×3, AppSet stanzas×3, and edge route. The node source, CI, review " +
      "rules, image build, and ExternalSecret leaves live in the minted node repo.";
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
