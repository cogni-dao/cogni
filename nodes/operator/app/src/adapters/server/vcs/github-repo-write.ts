// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/vcs/github-repo-write`
 * Purpose: Operator-only helper that mints node repos, commits files, and opens pull requests via the GitHub App.
 *   At formation it also replicates the monorepo's merge gate onto the node verbatim: branch
 *   protection, canonical repo settings (squash-only, auto-merge, is_template:false), and the `merge_queue` ruleset.
 * Scope: Thin Octokit calls behind node formation and candidate-flight prep.
 *   Does not belong in `VcsCapability` because that capability is shared with poly/resy/node-template stubs
 *   and these write ops are operator-only.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED: caller must verify the app is installed on the target repo; we surface a
 *     clear error if not. Installation must cover the node repo (private-safe).
 *   - NODE_FORMATION_TREE: a publish creates one reviewable tree — catalog row (with source_sha pin),
 *     overlay, AppSet, edge-route, and ExternalSecret shape. No gitlink, no .gitmodules
 *     (spec.node-submodule-retirement).
 *   - PR_AGAINST_MAIN: opens node-formation PRs against `main`; never force-pushes review branches.
 *   - PREVIEW_SOURCE_ADDRESSED: preview promotion dispatches `promote-and-deploy.yml`
 *     (ONE_PROMOTION_PRIMITIVE) source-addressed by the node image sha (`node_source_sha`
 *     input, like candidate-flight) and writes ZERO commits to `main`. The pin is recorded on
 *     `deploy/preview`. The App's main-write privilege is reserved for governance/code merges,
 *     never routine deploy pins (task.5022; the prior pin-PR/main-commit stalled or polluted main).
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
  CatalogForkTarget,
  MirrorCanonicalFilesInput,
  MirrorCanonicalFilesResult,
  NodePromoteResult,
  OperatorDeployPlanePort,
  PreparedNodeRefCandidateFlight,
  PrepareNodeRefCandidateFlightInput,
  PromoteNodeInput,
  ResolvedNodeRepo,
  ResolveNodeRepoInput,
  SyncTemplateUpstreamInput,
  SyncTemplateUpstreamResult,
} from "@/ports";
import {
  hasDistributionActivationSpec,
  hasPaymentsActivationSpec,
  insertAppsetKustomization,
  insertCaddyBlock,
  insertSchedulerEndpoint,
  NODE_FORMATION_ENVS,
  nextFreeNodePort,
  renderCatalog,
  renderDistributionActivationSpec,
  renderNodeAppset,
  renderNodeExternalSecret,
  renderNodeExternalSecretKustomization,
  renderOverlay,
  renderPaymentsActivationSpec,
  renderRepoSpec,
} from "@/shared/node-app-scaffold/gens";
import type { NodeKnowledgeRemote } from "@/shared/node-app-scaffold/knowledge-remote";
import {
  makeNodeLocalMatcher,
  parseNodeLocalPaths,
} from "@/shared/node-app-scaffold/node-local-paths";

export interface GitHubRepoWriterConfig {
  readonly appId: string;
  readonly privateKey: string;
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
  readonly tokenContract?: string;
  readonly knowledgeRemote?: NodeKnowledgeRemote;
}

export interface OpenNodeAppPrResult {
  readonly prNumber: number;
  readonly prUrl: string;
}

interface GitHubPullRequestSummary {
  readonly number: number;
  readonly html_url: string;
  readonly title?: string;
  readonly state?: string;
  readonly merged_at?: string | null;
  readonly merge_commit_sha?: string | null;
  readonly head?: {
    readonly ref?: string;
    readonly repo?: {
      readonly full_name?: string;
    };
  };
}

type ActivationPrStatus = {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "merged";
  readonly mergedAt: string | null;
  readonly mergeCommitSha: string | null;
} | null;

export interface PaymentsActivationStatusInput {
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
  readonly nodeWalletAddress: string;
  readonly splitAddress: string;
}

export interface PaymentsActivationStatus {
  readonly mainSha: string | null;
  readonly repoSpecActive: boolean;
  readonly activationPr: ActivationPrStatus;
}

export interface DistributionActivationInput {
  readonly owner: string;
  readonly repo: string;
  readonly slug: string;
  readonly tokenAddress: string;
  readonly emissionsHolderAddress: string;
}

export interface DistributionActivationStatus {
  readonly mainSha: string | null;
  readonly repoSpecActive: boolean;
  readonly activationPr: ActivationPrStatus;
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
  readonly tokenContract?: string;
  readonly knowledgeRemote?: NodeKnowledgeRemote;
  /** One-line node mission (`intent.mission`); a starter seed is emitted when omitted. */
  readonly mission?: string;
  /**
   * Repo whose `main` branch-protection is copied VERBATIM onto the new node repo
   * (the deployment monorepo — `NODE_SUBMODULE_PARENT_*`). The node inherits the
   * EXACT required-status-check set + flags the monorepo enforces, so there is one
   * SSOT for protection and the operator invents no node-specific policy. Omit to
   * skip protection (e.g. a test that doesn't exercise it).
   */
  readonly protectionSourceOwner?: string;
  readonly protectionSourceRepo?: string;
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
} as const;

/** Per-env appsets kustomization path — the PER-ENV `appsets/<env>/kustomization.yaml` the slug folds into. */
const appsetsKustomizationPath = (env: string): string =>
  `infra/k8s/argocd/appsets/${env}/kustomization.yaml`;

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

// Stable, SHA-free branches → ONE living PR per fork per tier, force-updated on each node-template
// merge (Dependabot/Renovate pattern: rebase-in-place, never delete+recreate). Keyed by the sync
// concern, not the source SHA, so a new template release refreshes the same PR instead of opening a new one.
const SYNC_BRANCH = "cogni-operator/node-template-sync";
const UPSTREAM_BRANCH = "cogni-operator/node-template-upstream";
const CHANGELOG_MAX = 30;

const CatalogEntrySchema = z.object({
  name: z.string(),
  type: z.literal("node"),
  path_prefix: z.string(),
  source_repo: z.string().url(),
  image_repository: z
    .string()
    .regex(/^ghcr\.io\/[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/),
});

// Promote-time discriminator: validates the slug identity + reads `source_repo` PRESENCE only
// (remote-source vs in-repo). `source_repo` is optional here — in-repo nodes (operator/poly) omit
// it — so this is intentionally laxer than CatalogEntrySchema (which mandates it for the
// remote-source fork path). We never read `source_sha`: it is birth-only metadata, not a deploy
// authority for promotion (bug.5043).
const PromoteDiscriminatorSchema = z.object({
  name: z.string(),
  source_repo: z.string().url().optional(),
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

/** Slugs that are catalog `type: node` but are never fork-sync targets. */
const FORK_SYNC_EXCLUDED_SLUGS = new Set(["node-template", "operator"]);

/**
 * Pure: one `infra/catalog/<slug>.yaml` body → a fork target, or null. Null when the row is not a
 * `type: node` with a parseable `source_repo`, or the slug is the source/hub. Exported for unit tests.
 */
export function catalogYamlToForkTarget(
  slug: string,
  yamlText: string
): CatalogForkTarget | null {
  if (FORK_SYNC_EXCLUDED_SLUGS.has(slug)) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch {
    return null;
  }
  const row = parsed as { type?: unknown; source_repo?: unknown };
  if (row?.type !== "node" || typeof row.source_repo !== "string") return null;
  try {
    const { owner, repo } = parseGithubRepoUrl(row.source_repo);
    return { owner, name: repo, slug };
  } catch {
    return null;
  }
}

// Node-content rename/delete (NODE_RENAME_PATHS / NODE_DELETE_PATHS) is gone with the inline
// `buildNodeSubtree`: a submodule node's app files live in its own repo (minted via
// `forkFromTemplate`). The operator writes only node identity plus the ESO-first leaf files that
// must be visible after the repo is mounted as `nodes/<slug>`.

/**
 * Qualify bare `#NN` PR/issue refs in a node-template commit subject to the source repo.
 * A bare `#NN` in a FORK's PR body auto-links to the FORK's own #NN (GitHub same-repo
 * resolution) — almost always a closed/unrelated PR, e.g. node-template's `(#25)` linking
 * to beacon#25. `owner/repo#NN` resolves to node-template instead. Refs already qualified
 * (`foo/bar#NN`) are left untouched (the char before `#` is then a word char). Exported for tests.
 */
export function qualifyUpstreamPrRefs(
  subject: string,
  owner: string,
  repo: string
): string {
  return subject.replace(/(^|[^\w/-])#(\d+)\b/g, `$1${owner}/${repo}#$2`);
}

/** Subset of GET branches/{branch}/protection that we replicate onto a node repo. */
interface ProtectionResponse {
  readonly required_status_checks?: {
    readonly strict?: boolean;
    readonly contexts?: readonly string[];
  } | null;
  readonly enforce_admins?: { readonly enabled?: boolean } | null;
  readonly required_pull_request_reviews?: {
    readonly dismiss_stale_reviews?: boolean;
    readonly require_code_owner_reviews?: boolean;
    readonly required_approving_review_count?: number;
  } | null;
  readonly required_linear_history?: { readonly enabled?: boolean };
  readonly allow_force_pushes?: { readonly enabled?: boolean };
  readonly allow_deletions?: { readonly enabled?: boolean };
  readonly required_conversation_resolution?: { readonly enabled?: boolean };
  readonly lock_branch?: { readonly enabled?: boolean };
  readonly allow_fork_syncing?: { readonly enabled?: boolean };
}

/**
 * Transform a GET branch-protection response into the flat PUT payload, copying
 * the source config verbatim for the fields we replicate. The GET nests each flag
 * under `{enabled}`; PUT wants flat booleans, and `required_status_checks` /
 * `enforce_admins` / `required_pull_request_reviews` / `restrictions` are required
 * (nullable). `restrictions` is intentionally NOT replicated — the canonical
 * monorepo config has none (push open) and the GET→PUT user/team/app shape is
 * lossy. Pure; exported for unit tests.
 */
export function protectionGetToPutPayload(src: ProtectionResponse): {
  required_status_checks: { strict: boolean; contexts: string[] } | null;
  enforce_admins: boolean;
  required_pull_request_reviews: {
    dismiss_stale_reviews: boolean;
    require_code_owner_reviews: boolean;
    required_approving_review_count: number;
  } | null;
  restrictions: null;
  required_linear_history: boolean;
  allow_force_pushes: boolean;
  allow_deletions: boolean;
  required_conversation_resolution: boolean;
  lock_branch: boolean;
  allow_fork_syncing: boolean;
} {
  const rsc = src.required_status_checks;
  const prr = src.required_pull_request_reviews;
  return {
    required_status_checks: rsc
      ? { strict: rsc.strict ?? false, contexts: [...(rsc.contexts ?? [])] }
      : null,
    enforce_admins: src.enforce_admins?.enabled ?? false,
    required_pull_request_reviews: prr
      ? {
          dismiss_stale_reviews: prr.dismiss_stale_reviews ?? false,
          require_code_owner_reviews: prr.require_code_owner_reviews ?? false,
          required_approving_review_count:
            prr.required_approving_review_count ?? 0,
        }
      : null,
    restrictions: null,
    required_linear_history: src.required_linear_history?.enabled ?? false,
    allow_force_pushes: src.allow_force_pushes?.enabled ?? false,
    allow_deletions: src.allow_deletions?.enabled ?? false,
    required_conversation_resolution:
      src.required_conversation_resolution?.enabled ?? false,
    lock_branch: src.lock_branch?.enabled ?? false,
    allow_fork_syncing: src.allow_fork_syncing?.enabled ?? false,
  };
}

/** The canonical name of the merge-queue ruleset (matches infra/github/merge-queue-ruleset.json). */
export const MERGE_QUEUE_RULESET_NAME = "main-merge-queue";

/** Subset of GET /repos/{owner}/{repo}/rulesets/{id} that we replicate onto a node repo. */
interface RulesetResponse {
  readonly name?: string;
  readonly target?: string;
  readonly enforcement?: string;
  readonly conditions?: {
    readonly ref_name?: {
      readonly include?: readonly string[];
      readonly exclude?: readonly string[];
    };
  } | null;
  readonly rules?: ReadonlyArray<{
    readonly type: string;
    readonly parameters?: Record<string, unknown>;
  }>;
  readonly bypass_actors?: ReadonlyArray<{
    readonly actor_id?: number | null;
    readonly actor_type?: string;
    readonly bypass_mode?: string;
  }>;
}

/** Flat POST/PUT body for the rulesets API — the write-accepted subset of a ruleset. */
export interface RulesetWritePayload {
  name: string;
  target: "branch";
  enforcement: "active" | "evaluate" | "disabled";
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
  bypass_actors: Array<{
    actor_id: number | null;
    actor_type: string;
    bypass_mode: string;
  }>;
}

/**
 * Transform a GET ruleset response into the POST/PUT body, copying the source
 * verbatim for the fields a write accepts (name, target, enforcement, conditions,
 * rules, bypass_actors) and dropping the read-only envelope (id, source, `*_at`,
 * node_id, `_links`, current_user_can_bypass). VERBATIM — the monorepo's ruleset
 * is the single source of truth, including any bypass actors it declares (our
 * canonical fixture declares none). Pure; exported for unit tests.
 */
export function rulesetGetToPutPayload(
  src: RulesetResponse
): RulesetWritePayload {
  const refName = src.conditions?.ref_name;
  const enforcement =
    src.enforcement === "active" ||
    src.enforcement === "evaluate" ||
    src.enforcement === "disabled"
      ? src.enforcement
      : "active";
  return {
    name: src.name ?? MERGE_QUEUE_RULESET_NAME,
    target: "branch",
    enforcement,
    conditions: {
      ref_name: {
        include: [...(refName?.include ?? ["~DEFAULT_BRANCH"])],
        exclude: [...(refName?.exclude ?? [])],
      },
    },
    rules: (src.rules ?? []).map((r) =>
      r.parameters
        ? { type: r.type, parameters: { ...r.parameters } }
        : { type: r.type }
    ),
    bypass_actors: (src.bypass_actors ?? []).map((a) => ({
      actor_id: a.actor_id ?? null,
      actor_type: a.actor_type ?? "RepositoryRole",
      bypass_mode: a.bypass_mode ?? "always",
    })),
  };
}

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
    // Discriminate remote-source vs in-repo by `source_repo` PRESENCE (same as
    // promoteNode). The operator is IN-REPO (no source_repo) — and it is a node
    // like any other: flighted by `nodeRef {nodeId, sourceSha}`, NOT a `codePr`/
    // pr_number lane (NORTH_STAR). Its deployable is the parent's own app image.
    const discriminator = PromoteDiscriminatorSchema.safeParse(
      parseYaml(catalogText)
    );
    if (!discriminator.success || discriminator.data.name !== slug) {
      throw deployPlaneError(
        "invalid_catalog",
        `invalid node catalog entry for ${slug}`,
        409
      );
    }

    if (discriminator.data.source_repo === undefined) {
      // IN-REPO node (operator): verify the commit + repo-spec identity in the
      // PARENT repo (the operator's own monorepo); the image is the parent app
      // image at sha-<sourceSha> (candidate-flight resolves it for real via
      // resolve-node-ref-image — image existence is not gated in-app).
      const sourceExists = await this.commitExists({
        owner: parentOwner,
        repo: parentRepo,
        ref: sourceSha,
      });
      if (!sourceExists) {
        throw deployPlaneError(
          "source_missing",
          `sourceSha not found in ${parentOwner}/${parentRepo}`,
          422
        );
      }
      const repoSpecText = await this.fetchFileText({
        owner: parentOwner,
        repo: parentRepo,
        path: `nodes/${slug}/.cogni/repo-spec.yaml`,
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
      return {
        nodeId,
        slug,
        sourceSha,
        sourceRepo: `https://github.com/${parentOwner}/${parentRepo}`,
        image: `ghcr.io/${parentOwner.toLowerCase()}/cogni-template:sha-${sourceSha}`,
      };
    }

    // REMOTE-SOURCE node: strict catalog (source_repo + image_repository required).
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

    // No catalog pin on `main`: candidate flight is source-addressed (the dispatch
    // carries `source_sha`), so the deploy pin never touches the operator code branch
    // (MAIN_WRITE_IS_GOVERNANCE_ONLY / ONE_PROMOTION_PRIMITIVE, task.5022). The prior
    // pin PR stalled open forever — a catalog-only PR earns no required merge_group
    // checks and a bot catalog commit carries no `(#NNN)` for any flight rung to resolve.
    return {
      nodeId,
      slug,
      sourceSha,
      sourceRepo: catalog.data.source_repo,
      image: `${catalog.data.image_repository}:sha-${sourceSha}`,
    };
  }

  /**
   * Resolve a node's own repo from `infra/catalog/<slug>.yaml` (read via the App — the catalog is
   * absent on the operator's runtime disk). ONE resolution path for every node, using the SAME
   * `source_repo`-PRESENCE discriminator as `promoteNode`/`prepareNodeRefCandidateFlight`:
   *   - IN-REPO node (no `source_repo`, e.g. the operator): its repo IS the parent monorepo.
   *     Returns `{ parentOwner, parentRepo }` so `{nodeId:operator}` resolves like any node — callers
   *     no longer need a per-site `catalog_missing`→monorepo fallback.
   *   - REMOTE-SOURCE node (fork): parse its own `source_repo`.
   * `catalog_missing` (404) is reserved for a genuinely absent row (file missing / name mismatch),
   * so a typo'd slug still hard-404s — NODE_SCOPED_NEVER_RETARGETS holds.
   */
  async resolveNodeRepo(
    input: ResolveNodeRepoInput
  ): Promise<ResolvedNodeRepo> {
    const { parentOwner, parentRepo, slug } = input;

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

    const discriminator = PromoteDiscriminatorSchema.safeParse(
      parseYaml(catalogText)
    );
    if (!discriminator.success || discriminator.data.name !== slug) {
      throw deployPlaneError(
        "catalog_missing",
        `node catalog entry not found for ${slug}`,
        404
      );
    }

    // IN-REPO node (operator): its repo is the parent monorepo.
    if (discriminator.data.source_repo === undefined) {
      return { owner: parentOwner, repo: parentRepo };
    }

    // REMOTE-SOURCE node (fork): resolve its own source repo.
    return parseGithubRepoUrl(discriminator.data.source_repo);
  }

  /**
   * Promote a node to preview OR production — ONE code path, ONE_PROMOTION_PRIMITIVE
   * (PROMOTION_RUNS_AS_THE_OPERATOR). The rung differs ONLY by the dispatched `env` and the
   * route's authz: preview is the ungated node-merge hook; production is RBAC-gated on
   * `node.promote_production`, enforced BEFORE this is called. Writes ZERO commits to `main`.
   *
   * SOURCE_ADDRESSED_LIKE_CANDIDATE_FLIGHT: for a REMOTE-SOURCE (fork) node the node image sha
   * rides the dispatch as `node_source_sha` — the same source-addressing candidate-flight.yml
   * already uses. promote-and-deploy's "Resolve digest for this node" remote-source branch PREFERS
   * that input over the `yq '.source_sha' infra/catalog/<slug>.yaml` read, so the node head sha
   * resolves the image directly. The pin is recorded where deploy state belongs —
   * `.promote-state/source-sha-by-app.json` on `deploy/<env>` (update-source-sha-map.sh) — never on
   * `main`. The operator App's main-write privilege is reserved for governance/code merges, not
   * routine deploy pins.
   *
   * Reads the parent catalog row via the App (it is absent on the operator's runtime disk) ONLY to
   * DISCRIMINATE the node kind — `source_repo` PRESENCE, never `source_sha`, drives resolution:
   *   - REMOTE-SOURCE (catalog has `source_repo`, e.g. beacon): `node_source_sha = sourceSha`, NO
   *     `source_sha`. The catalog `source_sha` is birth-only metadata, never a deploy authority
   *     for promotion (the stale-pin vestige bug.5043 retired).
   *   - IN-REPO (no `source_repo`, e.g. operator/poly): pass `source_sha = sourceSha` (the operator
   *     checkout ref); in-repo nodes are not source-addressed by node sha.
   * A missing/mismatched row is a real misconfiguration (404/409). Image existence is NOT gated
   * in-app: the GitHub Packages API false-negatives on private node images (git-app-expert), so the
   * workflow's own "image not found" hard-fail is the loud backstop.
   *
   * (This replaces the stalling pin-PR — and its successor direct-main-commit — that polluted
   * `main` with a deploy-state firehose: PRs #1699/#1700/#1711, task.5022.)
   */
  async promoteNode(input: PromoteNodeInput): Promise<NodePromoteResult> {
    const { env, parentOwner, parentRepo, slug, sourceSha } = input;
    if (!SOURCE_SHA_PATTERN.test(sourceSha)) {
      throw deployPlaneError(
        "invalid_source_sha",
        "sourceSha must be a 40-character hex SHA",
        400
      );
    }

    // Confirm the catalog row exists + identifies this slug, and read ONLY `source_repo`'s presence
    // (the remote-source vs in-repo discriminator). We never read `source_sha` for resolution.
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
    const row = PromoteDiscriminatorSchema.safeParse(parseYaml(catalogText));
    if (!row.success || row.data.name !== slug) {
      throw deployPlaneError(
        "invalid_catalog",
        `invalid node catalog entry for ${slug}`,
        409
      );
    }
    const isRemoteSource = row.data.source_repo !== undefined;

    const dispatch = await this.dispatchNodePromote({
      owner: parentOwner,
      repo: parentRepo,
      env,
      slug,
      // REMOTE-SOURCE: source-address the node image (no source_sha — operator checkout ref stays
      // main). IN-REPO: source_sha is the operator checkout ref.
      ...(isRemoteSource ? { nodeSourceSha: sourceSha } : { sourceSha }),
    });

    return {
      status: "dispatched",
      env,
      sourceSha,
      sourceAddressing: isRemoteSource ? "remote_source" : "in_repo",
      workflowUrl: dispatch.workflowUrl,
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

  async dispatchPrBuild(input: {
    owner: string;
    repo: string;
    headRepo: string;
    headSha: string;
    prNumber: number;
  }): Promise<CandidateFlightDispatchResult> {
    const octokit = await this.getOctokit(input.owner, input.repo);
    // workflow_dispatch on the SAME pr-build.yml (ref: main = the trusted workflow
    // definition), building the approved head at headRepo@headSha → sha-<headSha>.
    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches",
      {
        owner: input.owner,
        repo: input.repo,
        workflow_id: "pr-build.yml",
        ref: "main",
        inputs: {
          head_repo: input.headRepo,
          head_sha: input.headSha,
          pr_number: String(input.prNumber),
        },
        request: { signal: AbortSignal.timeout(15_000) },
      }
    );
    return {
      dispatched: true,
      workflowUrl: `https://github.com/${input.owner}/${input.repo}/actions/workflows/pr-build.yml`,
      message: `Trusted build dispatched for ${input.headRepo}@${input.headSha.slice(0, 8)} (PR #${input.prNumber}).`,
    };
  }

  async dispatchNodePromote(input: {
    owner: string;
    repo: string;
    env: string;
    slug: string;
    sourceSha?: string;
    nodeSourceSha?: string;
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
    // Source-addressed node image sha (like candidate-flight): when present, the
    // workflow's remote-source digest resolver pins THIS instead of reading the
    // catalog `source_sha` on the checked-out operator ref — so preview promote needs
    // NO catalog write to operator main. Absent (production) ⇒ workflow reads the
    // catalog pin, behavior unchanged.
    if (input.nodeSourceSha) inputs.node_source_sha = input.nodeSourceSha;
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

  /**
   * Grant a GitHub identity branch-push (Write) on a node repo — the operator App as the
   * privilege bridge for the contributor golden path (rbac.md §6a, TRUST_BOUNDARY_IS_MERGE_NOT_PUSH).
   * The App installation supplies the privilege (`administration: write`); the agent never holds
   * standing GitHub admin. Idempotent: re-granting an existing collaborator is a GitHub no-op.
   * Returns the invitation id when GitHub creates a pending invite (an outside collaborator the agent
   * then auto-accepts with its own token — §6 step 5), or null when the grant applied immediately
   * (org member / already a collaborator).
   */
  async setNodeCollaborator(input: {
    owner: string;
    repo: string;
    login: string;
    permission?: "pull" | "triage" | "push" | "maintain" | "admin";
  }): Promise<{ invitationId: number | null }> {
    const octokit = await this.getOctokit(input.owner, input.repo);
    const { status, data } = await octokit.request(
      "PUT /repos/{owner}/{repo}/collaborators/{username}",
      {
        owner: input.owner,
        repo: input.repo,
        username: input.login,
        permission: input.permission ?? "push",
      }
    );
    // 201 + invitation body ⇒ pending acceptance; 204 ⇒ applied immediately (already a member).
    const invitationId =
      status === 201 && data && typeof data === "object" && "id" in data
        ? (data as { id: number }).id
        : null;
    return { invitationId };
  }

  /**
   * Revoke a node-repo collaborator (rbac.md §6a de-provision, on reject/revoke). Idempotent: a 404
   * (already not a collaborator) is treated as success so revocation is safe to retry.
   */
  async removeNodeCollaborator(input: {
    owner: string;
    repo: string;
    login: string;
  }): Promise<void> {
    const octokit = await this.getOctokit(input.owner, input.repo);
    try {
      await octokit.request(
        "DELETE /repos/{owner}/{repo}/collaborators/{username}",
        { owner: input.owner, repo: input.repo, username: input.login }
      );
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return;
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

  async syncCanonicalFilesToFork(
    input: MirrorCanonicalFilesInput
  ): Promise<MirrorCanonicalFilesResult> {
    const {
      sourceOwner,
      sourceRepo,
      sourceRef,
      targetOwner,
      targetRepo,
      slug,
      canonicalPaths,
    } = input;

    const srcOctokit = await this.getOctokit(sourceOwner, sourceRepo);
    const tgtOctokit = await this.getOctokit(targetOwner, targetRepo);

    // Resolve the canonical content version → a deterministic, idempotent head branch.
    const sourceSha = await this.resolveCommitSha(
      srcOctokit,
      sourceOwner,
      sourceRepo,
      sourceRef
    );
    const shortSha = sourceSha.slice(0, 8);
    const branch = SYNC_BRANCH;

    // Read each canonical file from source@sourceSha; diff against the fork's main; keep changed-only.
    const changedPaths: string[] = [];
    const entries: GitTreeEntry[] = [];
    for (const path of canonicalPaths) {
      const sourceContent = await this.readFileAtRef(
        srcOctokit,
        sourceOwner,
        sourceRepo,
        path,
        sourceSha
      );
      if (sourceContent === null) {
        throw deployPlaneError(
          "canonical_missing",
          `canonical file ${path} not found in ${sourceOwner}/${sourceRepo}@${shortSha}`,
          422
        );
      }
      const targetContent = await this.readFileAtRef(
        tgtOctokit,
        targetOwner,
        targetRepo,
        path,
        "main"
      );
      if (targetContent === sourceContent) continue;
      changedPaths.push(path);
      const blobSha = await this.createBlob(
        tgtOctokit,
        targetOwner,
        targetRepo,
        sourceContent
      );
      entries.push({ path, mode: "100644", type: "blob", sha: blobSha });
    }

    if (entries.length === 0) {
      return { status: "no_changes", branch, changedPaths: [] };
    }

    const { baseCommitSha, baseTreeSha } = await this.resolveMainBase(
      tgtOctokit,
      targetOwner,
      targetRepo
    );
    const fileList = changedPaths.map((p) => `- \`${p}\``).join("\n");
    const title = "chore: sync CI + contract files from node-template";
    const body =
      `Syncs this fork's canonical files to \`${sourceOwner}/${sourceRepo}@${shortSha}\`. ` +
      `One PR, force-updated on each node-template release — not a new PR per change.\n\n` +
      `Files overwritten to match canonical (${changedPaths.length}):\n${fileList}\n\n` +
      `_Maintained automatically by cogni-operator._`;
    const { prNumber, prUrl } = await this.commitTreeAndOpenPr(
      tgtOctokit,
      targetOwner,
      targetRepo,
      slug,
      {
        baseCommitSha,
        baseTreeSha,
        entries,
        message: `chore: sync canonical files from ${sourceOwner}/${sourceRepo}@${shortSha}`,
        branch,
        pr: { title, body },
      }
    );
    // Living PR: openOrFindPr only sets title/body on CREATE, so refresh them on the reused PR.
    await this.updatePrBody(
      tgtOctokit,
      targetOwner,
      targetRepo,
      prNumber,
      title,
      body
    );
    return { status: "pr_opened", branch, prNumber, prUrl, changedPaths };
  }

  async resolveNodeLocalPaths(input: {
    sourceOwner: string;
    sourceRepo: string;
    sourceRef: string;
  }): Promise<readonly string[]> {
    const manifest = await this.fetchFileText({
      owner: input.sourceOwner,
      repo: input.sourceRepo,
      path: ".cogni/sync-manifest.yaml",
      ref: input.sourceRef,
    });
    return parseNodeLocalPaths(manifest);
  }

  async listCatalogForkTargets(input: {
    parentOwner: string;
    parentRepo: string;
  }): Promise<readonly CatalogForkTarget[]> {
    const { parentOwner, parentRepo } = input;
    const octokit = await this.getOctokit(parentOwner, parentRepo);
    let entries: Array<{ name: string; type: string }>;
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner: parentOwner,
          repo: parentRepo,
          path: "infra/catalog",
          ref: "main",
        }
      );
      entries = Array.isArray(data)
        ? (data as Array<{ name: string; type: string }>)
        : [];
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return [];
      throw error;
    }
    const targets: CatalogForkTarget[] = [];
    for (const entry of entries) {
      if (entry.type !== "file" || !entry.name.endsWith(".yaml")) continue;
      const slug = entry.name.replace(/\.yaml$/, "");
      if (FORK_SYNC_EXCLUDED_SLUGS.has(slug)) continue;
      const text = await this.fetchFileText({
        owner: parentOwner,
        repo: parentRepo,
        path: `infra/catalog/${entry.name}`,
      });
      if (!text) continue;
      const target = catalogYamlToForkTarget(slug, text);
      if (target) targets.push(target);
    }
    return targets;
  }

  async syncTemplateUpstreamToFork(
    input: SyncTemplateUpstreamInput
  ): Promise<SyncTemplateUpstreamResult> {
    const {
      templateOwner,
      templateRepo,
      templateSha,
      forkOwner,
      forkRepo,
      forkBranch,
      nodeLocalPaths,
    } = input;
    // Same-org cross-fork PRs can't disambiguate by `owner:branch` (template + fork share an owner →
    // GitHub resolves head to the base repo → false "up to date"). Instead materialize the upstream
    // commit as a branch IN the fork (the SHA is reachable via the shared fork network), then open a
    // SAME-repo PR head=that branch → base=fork main. The diff is exactly the un-merged upstream deltas.
    // Living PR: one stable branch force-updated to the latest node-template tip (Dependabot pattern).
    // Same-org cross-fork PRs can't disambiguate by `owner:branch`, so materialize the upstream commit
    // as a branch IN the fork (reachable via the shared fork network) + a SAME-repo PR head→base.
    const octokit = await this.getOctokit(forkOwner, forkRepo);
    // Build the always-mergeable Tier-2 merge commit: base on the fork tip, overlay node-template's
    // shared (non-node-local) blobs so node-template wins Tier-2, leave Tier-3 (node_local) the fork's,
    // and parent on the fork tip so the upstream branch is a descendant of fork main → the PR is always
    // conflict-free (TIER2_IS_ALWAYS_MERGEABLE, spec.repo-sync-contract). No fork-owner conflict resolution.
    const branchSha = await this.buildUpstreamMergeCommit(
      octokit,
      forkOwner,
      forkRepo,
      forkBranch,
      templateSha,
      nodeLocalPaths ?? []
    );
    await this.upsertRef(
      octokit,
      forkOwner,
      forkRepo,
      UPSTREAM_BRANCH,
      branchSha
    );
    const title = "chore: merge node-template upstream";

    let pr: { number: number; html_url: string };
    try {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls",
        {
          owner: forkOwner,
          repo: forkRepo,
          title,
          body: title,
          head: UPSTREAM_BRANCH,
          base: forkBranch,
        }
      );
      pr = data;
    } catch (err) {
      if ((err as { status?: number })?.status !== 422) throw err;
      const { data: existing } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls",
        {
          owner: forkOwner,
          repo: forkRepo,
          state: "open",
          head: `${forkOwner}:${UPSTREAM_BRANCH}`,
          per_page: 1,
        }
      );
      const found = existing[0];
      // No commits between the branch and fork main, and no open PR → fork already current.
      if (!found) return { status: "up_to_date" };
      pr = found;
    }

    // Body = the node-template commit changelog this PR carries (lint'd PR titles → clean enumeration).
    const subjects = await this.prCommitSubjects(
      octokit,
      forkOwner,
      forkRepo,
      pr.number
    );
    const log = subjects.length
      ? subjects
          .map(
            (s) => `- ${qualifyUpstreamPrRefs(s, templateOwner, templateRepo)}`
          )
          .join("\n")
      : "_(no commits — see the Commits tab)_";
    const body =
      `Merges node-template's Tier-2 substrate into this fork. node-template is authoritative for ` +
      `shared substrate (Tier-2, auto-updated); your node identity/presentation (Tier-3, \`node_local\`) ` +
      `and fork-unique files are preserved. Always conflict-free — safe to merge as-is. ` +
      `One PR, force-updated as node-template advances.\n\n` +
      `Up to \`${templateOwner}/${templateRepo}@${templateSha.slice(0, 8)}\` — node-template changes:\n` +
      `${log}\n\n` +
      `_Maintained automatically by cogni-operator._`;
    await this.updatePrBody(
      octokit,
      forkOwner,
      forkRepo,
      pr.number,
      title,
      body
    );
    return { status: "pr_opened", prNumber: pr.number, prUrl: pr.html_url };
  }

  /** First line of each commit on a PR (lint'd subjects → changelog), newest-capped. */
  private async prCommitSubjects(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<string[]> {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
        { owner, repo, pull_number: prNumber, per_page: CHANGELOG_MAX }
      );
      return (data as Array<{ commit: { message: string } }>)
        .map((c) => c.commit.message.split("\n")[0]?.trim() ?? "")
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  /** Refresh a living PR's title + body (openOrFindPr only sets them on create). */
  private async updatePrBody(
    octokit: Octokit,
    owner: string,
    repo: string,
    prNumber: number,
    title: string,
    body: string
  ): Promise<void> {
    try {
      await octokit.request("PATCH /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: prNumber,
        title,
        body,
      });
    } catch {
      // Best-effort body refresh; never fail the sync over a description update.
    }
  }

  /** Resolve a ref to a 40-char commit SHA: pass-through if already a SHA, else look up `heads/<ref>`. */
  private async resolveCommitSha(
    octokit: Octokit,
    owner: string,
    repo: string,
    ref: string
  ): Promise<string> {
    if (SOURCE_SHA_PATTERN.test(ref)) return ref;
    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/ref/{ref}",
      { owner, repo, ref: `heads/${ref}` }
    );
    return data.object.sha;
  }

  /** Read a file's UTF-8 contents at any ref; null on 404. Blob fallback for >1MB files. */
  private async readFileAtRef(
    octokit: Octokit,
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string | null> {
    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        { owner, repo, path, ref }
      );
      if (Array.isArray(data) || data.type !== "file") return null;
      if (data.encoding === "base64" && data.content) {
        return Buffer.from(data.content, "base64").toString("utf-8");
      }
      return this.readBlob(octokit, owner, repo, data.sha);
    } catch (error) {
      if ((error as { status?: number })?.status === 404) return null;
      throw error;
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
        tokenContract: input.tokenContract,
        knowledgeRemote: input.knowledgeRemote,
        mission: input.mission,
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
    // Born protected: copy the monorepo's branch protection VERBATIM onto the new
    // node repo, so its `main` enforces the EXACT required checks the network does.
    // A node without protection makes the operator's merge-on-green hollow; fail
    // loud — an unprotected node is not a formed node.
    if (input.protectionSourceOwner && input.protectionSourceRepo) {
      const sourceOctokit = await this.getOctokit(
        input.protectionSourceOwner,
        input.protectionSourceRepo
      );
      await this.replicateBranchProtection(
        sourceOctokit,
        input.protectionSourceOwner,
        input.protectionSourceRepo,
        octokit,
        owner,
        slug
      );
      // Born with the monorepo's merge mechanism too: canonical repo settings
      // (squash-only, auto-merge on, delete-on-merge — auto-merge is REQUIRED for
      // the queue path; plus `is_template:false` since forking the template repo
      // inherits its template flag) + the `merge_queue` ruleset copied verbatim
      // from the monorepo. The queue is admin-opt-in on the monorepo, so when it
      // is not yet enabled there this is a clean skip (the node mirrors the
      // monorepo: born queue-less). See docs/spec/merge-authority.md.
      await this.ensureCanonicalRepoSettings(octokit, owner, slug);
      await this.replicateMergeQueue(
        sourceOctokit,
        input.protectionSourceOwner,
        input.protectionSourceRepo,
        octokit,
        owner,
        slug
      );
    }
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
   * Payment-activation write-back into the NODE'S OWN repo (not the operator monorepo): read the
   * node repo's `.cogni/repo-spec.yaml` on `main`, splice in `node_wallet.address` +
   * `payments_in.credits_topup.*` (95/5 at-cost) + `payments.status: active`, and open (or reuse)
   * a PR carrying that one-file change. The {owner, repo} here is the node's OWN repo identity
   * (`NODE_MINT_OWNER`/slug), built by the route exactly like `publish` builds it.
   *
   * SINGLE_HOME: writes ONLY `.cogni/repo-spec.yaml` at the repo root. Idempotent: an already-spliced
   * spec produces an identical tree (no commit, returns `no_changes`).
   */
  async openPaymentsActivationPr(input: {
    owner: string;
    repo: string;
    slug: string;
    nodeWalletAddress: string;
    splitAddress: string;
  }): Promise<
    | { status: "pr_opened"; prNumber: number; prUrl: string }
    | { status: "no_changes" }
  > {
    const { owner, repo, slug } = input;
    const octokit = await this.getOctokit(owner, repo);
    const branch = `cogni-operator/activate-payments-${slug}`;
    const title = `feat(payments): activate ${slug} payment rails`;
    const body =
      `Activates \`${slug}\`'s payment loop. Writes the node's own wallet + Split into ` +
      "`.cogni/repo-spec.yaml`:\n\n" +
      `- \`node_wallet.address\` = \`${input.nodeWalletAddress}\`\n` +
      `- \`payments_in.credits_topup.receiving_address\` (Split) = \`${input.splitAddress}\`\n` +
      `- \`payments.status: active\` (95/5 at-cost economics)\n\n` +
      "Inbound USDC routes to this node's own Split, then funds its AI credits. " +
      "The operator never holds the node's keys.\n\n" +
      "_Authored automatically by cogni-operator on payment activation._";

    const currentSpec = await this.fetchFileText({
      owner,
      repo,
      path: ".cogni/repo-spec.yaml",
      ref: "main",
    });
    if (currentSpec === null) {
      throw deployPlaneError(
        "repo_spec_missing",
        `node repo-spec not found at ${owner}/${repo}:.cogni/repo-spec.yaml`,
        422
      );
    }

    const nextSpec = renderPaymentsActivationSpec(currentSpec, {
      nodeWalletAddress: input.nodeWalletAddress,
      splitAddress: input.splitAddress,
    });
    if (
      nextSpec === currentSpec ||
      hasPaymentsActivationSpec(currentSpec, {
        nodeWalletAddress: input.nodeWalletAddress,
        splitAddress: input.splitAddress,
      })
    ) {
      return { status: "no_changes" };
    }

    const existingPr = await this.findOpenPrForBranch(octokit, owner, repo, {
      branch,
      title,
    });
    if (existingPr) {
      const pendingSpec = await this.fetchFileText({
        owner,
        repo,
        path: ".cogni/repo-spec.yaml",
        ref: branch,
      });
      if (
        pendingSpec === nextSpec ||
        (pendingSpec !== null &&
          hasPaymentsActivationSpec(pendingSpec, {
            nodeWalletAddress: input.nodeWalletAddress,
            splitAddress: input.splitAddress,
          }))
      ) {
        await this.updatePrBody(
          octokit,
          owner,
          repo,
          existingPr.prNumber,
          title,
          body
        );
        return { status: "pr_opened", ...existingPr };
      }
    }

    const { baseCommitSha, baseTreeSha } = await this.resolveMainBase(
      octokit,
      owner,
      repo
    );
    const blobSha = await this.createBlob(octokit, owner, repo, nextSpec);

    const result = await this.commitTreeAndOpenPr(octokit, owner, repo, slug, {
      baseCommitSha,
      baseTreeSha,
      entries: [
        {
          path: ".cogni/repo-spec.yaml",
          mode: "100644",
          type: "blob",
          sha: blobSha,
        },
      ],
      message: `feat(payments): activate ${slug} payment rails`,
      branch,
      pr: { title, body },
    });
    await this.updatePrBody(octokit, owner, repo, result.prNumber, title, body);
    return { status: "pr_opened", ...result };
  }

  /**
   * Distribution-activation write-back into the NODE'S OWN repo: read `.cogni/repo-spec.yaml` on
   * `main`, splice in the Aragon GovernanceERC20 token, DAO-controlled emissions holder, and active
   * distribution status with the stock Uniswap MerkleDistributor claim pattern, then open or reuse a
   * one-file PR. This is intentionally independent from formation and payments activation.
   */
  async openDistributionActivationPr(
    input: DistributionActivationInput
  ): Promise<
    | { status: "pr_opened"; prNumber: number; prUrl: string }
    | { status: "no_changes" }
  > {
    const { owner, repo, slug } = input;
    const octokit = await this.getOctokit(owner, repo);
    const branch = `cogni-operator/activate-distributions-${slug}`;
    const title = `feat(distributions): activate ${slug} token distributions`;
    const body =
      `Activates \`${slug}\`'s token distribution lifecycle. Writes the verified ` +
      "GovernanceERC20 token + DAO-controlled emissions holder into `.cogni/repo-spec.yaml`:\n\n" +
      `- \`governance.token_contract\` = \`${input.tokenAddress}\`\n` +
      `- \`governance.emissions_holder\` = \`${input.emissionsHolderAddress}\`\n` +
      "- `distributions.status: active`\n" +
      "- `distributions.claim_contract_pattern: uniswap.merkle-distributor.v1`\n\n" +
      "This only records verified distribution readiness. Per-epoch claims still use the OSS " +
      "MerkleDistributor path and require a separately funded epoch distributor.\n\n" +
      "_Authored automatically by cogni-operator on distribution activation._";

    const currentSpec = await this.fetchFileText({
      owner,
      repo,
      path: ".cogni/repo-spec.yaml",
      ref: "main",
    });
    if (currentSpec === null) {
      throw deployPlaneError(
        "repo_spec_missing",
        `node repo-spec not found at ${owner}/${repo}:.cogni/repo-spec.yaml`,
        422
      );
    }

    const nextSpec = renderDistributionActivationSpec(currentSpec, {
      tokenAddress: input.tokenAddress,
      emissionsHolderAddress: input.emissionsHolderAddress,
    });
    if (
      nextSpec === currentSpec ||
      hasDistributionActivationSpec(currentSpec, {
        tokenAddress: input.tokenAddress,
        emissionsHolderAddress: input.emissionsHolderAddress,
      })
    ) {
      return { status: "no_changes" };
    }

    const existingPr = await this.findOpenPrForBranch(octokit, owner, repo, {
      branch,
      title,
    });
    if (existingPr) {
      const pendingSpec = await this.fetchFileText({
        owner,
        repo,
        path: ".cogni/repo-spec.yaml",
        ref: branch,
      });
      if (
        pendingSpec === nextSpec ||
        (pendingSpec !== null &&
          hasDistributionActivationSpec(pendingSpec, {
            tokenAddress: input.tokenAddress,
            emissionsHolderAddress: input.emissionsHolderAddress,
          }))
      ) {
        await this.updatePrBody(
          octokit,
          owner,
          repo,
          existingPr.prNumber,
          title,
          body
        );
        return { status: "pr_opened", ...existingPr };
      }
    }

    const { baseCommitSha, baseTreeSha } = await this.resolveMainBase(
      octokit,
      owner,
      repo
    );
    const blobSha = await this.createBlob(octokit, owner, repo, nextSpec);

    const result = await this.commitTreeAndOpenPr(octokit, owner, repo, slug, {
      baseCommitSha,
      baseTreeSha,
      entries: [
        {
          path: ".cogni/repo-spec.yaml",
          mode: "100644",
          type: "blob",
          sha: blobSha,
        },
      ],
      message: `feat(distributions): activate ${slug} token distributions`,
      branch,
      pr: { title, body },
    });
    await this.updatePrBody(octokit, owner, repo, result.prNumber, title, body);
    return { status: "pr_opened", ...result };
  }

  async getDistributionActivationStatus(
    input: DistributionActivationInput
  ): Promise<DistributionActivationStatus> {
    const { owner, repo, slug } = input;
    const octokit = await this.getOctokit(owner, repo);
    const branch = `cogni-operator/activate-distributions-${slug}`;
    const title = `feat(distributions): activate ${slug} token distributions`;

    const currentSpec = await this.fetchFileText({
      owner,
      repo,
      path: ".cogni/repo-spec.yaml",
      ref: "main",
    });
    const repoSpecActive =
      currentSpec !== null &&
      hasDistributionActivationSpec(currentSpec, {
        tokenAddress: input.tokenAddress,
        emissionsHolderAddress: input.emissionsHolderAddress,
      });

    let mainSha: string | null = null;
    try {
      mainSha = await this.resolveCommitSha(octokit, owner, repo, "main");
    } catch (error) {
      if ((error as { status?: number })?.status !== 404) throw error;
    }

    const openPr = await this.findOpenPrForBranch(octokit, owner, repo, {
      branch,
      title,
    });
    if (openPr) {
      return {
        mainSha,
        repoSpecActive,
        activationPr: {
          number: openPr.prNumber,
          url: openPr.prUrl,
          state: "open",
          mergedAt: null,
          mergeCommitSha: null,
        },
      };
    }

    const mergedPr = await this.findMergedPrForBranch(octokit, owner, repo, {
      branch,
      title,
    });
    return {
      mainSha,
      repoSpecActive,
      activationPr: mergedPr,
    };
  }

  async getPaymentsActivationStatus(
    input: PaymentsActivationStatusInput
  ): Promise<PaymentsActivationStatus> {
    const { owner, repo, slug } = input;
    const octokit = await this.getOctokit(owner, repo);
    const branch = `cogni-operator/activate-payments-${slug}`;
    const title = `feat(payments): activate ${slug} payment rails`;

    const currentSpec = await this.fetchFileText({
      owner,
      repo,
      path: ".cogni/repo-spec.yaml",
      ref: "main",
    });
    const repoSpecActive =
      currentSpec !== null &&
      hasPaymentsActivationSpec(currentSpec, {
        nodeWalletAddress: input.nodeWalletAddress,
        splitAddress: input.splitAddress,
      });

    let mainSha: string | null = null;
    try {
      mainSha = await this.resolveCommitSha(octokit, owner, repo, "main");
    } catch (error) {
      if ((error as { status?: number })?.status !== 404) throw error;
    }

    const openPr = await this.findOpenPrForBranch(octokit, owner, repo, {
      branch,
      title,
    });
    if (openPr) {
      return {
        mainSha,
        repoSpecActive,
        activationPr: {
          number: openPr.prNumber,
          url: openPr.prUrl,
          state: "open",
          mergedAt: null,
          mergeCommitSha: null,
        },
      };
    }

    const mergedPr = await this.findMergedPrForBranch(octokit, owner, repo, {
      branch,
      title,
    });
    return {
      mainSha,
      repoSpecActive,
      activationPr: mergedPr,
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
   * Build the always-mergeable Tier-2 sync commit, realizing the three-tier model
   * (spec.repo-sync-contract): **node-template is AUTHORITATIVE for Tier-2** ("foundational
   * substrate, auto-updated") while the **fork OWNS Tier-3** (`node_local` identity/presentation,
   * never touched). Construction:
   *   - start from the FORK's `forkBranch` tree as the base, so fork-unique files survive;
   *   - overlay node-template's blob (preserving its mode — scripts stay executable) for every
   *     NON-node-local path that differs → node-template wins shared files
   *     (`TIER2_NODE_TEMPLATE_AUTHORITATIVE`). This is what resolves the recurring conflict class:
   *     a fork that drifted in a shared path (e.g. a hand-ported fix re-authored with a different
   *     comment — `ONE_FIX_ONE_LINEAGE`) is simply overwritten with node-template's version;
   *   - leave node-local paths as the fork's (`TIER3_NEVER_SYNCED`);
   *   - parent the commit on BOTH the fork tip AND `templateSha`, so the upstream branch is a
   *     descendant of fork `main`. The same-repo PR head=branch → base=forkBranch is therefore
   *     ALWAYS conflict-free (`TIER2_IS_ALWAYS_MERGEABLE`), no fork-owner conflict resolution.
   * Limitation: node-template's *deletions* of shared files do not propagate (a fork keeps a shared
   * file node-template removed) — we never delete from the fork tree here, to protect fork-unique files.
   * @returns the merge commit SHA, or the fork tip SHA when nothing in Tier-2 differs (PR no-ops → up_to_date).
   */
  private async buildUpstreamMergeCommit(
    octokit: Octokit,
    owner: string,
    repo: string,
    forkBranch: string,
    templateSha: string,
    nodeLocalPaths: readonly string[]
  ): Promise<string> {
    const isNodeLocal = nodeLocalPaths.length
      ? makeNodeLocalMatcher(nodeLocalPaths)
      : () => false;

    // Fork tip → base tree (fork-unique files + Tier-3 ride along untouched).
    const forkMainSha = await this.resolveCommitSha(
      octokit,
      owner,
      repo,
      forkBranch
    );
    const { tipTreeSha: forkTreeSha, blobs: forkBlobs } =
      await this.listTreeBlobsAtCommit(octokit, owner, repo, forkMainSha);

    // Upstream tip → recursive tree WITH modes (overlay source; node-template wins Tier-2).
    const { data: upstreamCommit } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { owner, repo, commit_sha: templateSha }
    );
    const { data: upstreamTree } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: upstreamCommit.tree.sha, recursive: "1" }
    );

    const entries: GitTreeEntry[] = [];
    for (const e of upstreamTree.tree) {
      if (e.type !== "blob" || !e.path || !e.sha || !e.mode) continue;
      if (isNodeLocal(e.path)) continue; // Tier-3 stays the fork's.
      if (forkBlobs.get(e.path) === e.sha) continue; // already identical.
      entries.push({
        path: e.path,
        mode: e.mode as GitTreeEntry["mode"],
        type: "blob",
        sha: e.sha,
      });
    }

    // Nothing in Tier-2 differs → fork already current; caller's PR-open no-ops to up_to_date.
    if (entries.length === 0) return forkMainSha;

    const { data: tree } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/trees",
      { owner, repo, base_tree: forkTreeSha, tree: entries }
    );
    const { data: commit } = await octokit.request(
      "POST /repos/{owner}/{repo}/git/commits",
      {
        owner,
        repo,
        message:
          "chore: merge node-template upstream (Tier-2 substrate; Tier-3 identity preserved)",
        tree: tree.sha,
        parents: [forkMainSha, templateSha],
      }
    );
    return commit.sha;
  }

  /** Resolve a commit SHA → its tip tree SHA + recursive blob map (`path → blob sha`). */
  private async listTreeBlobsAtCommit(
    octokit: Octokit,
    owner: string,
    repo: string,
    commitSha: string
  ): Promise<{ tipTreeSha: string; blobs: Map<string, string> }> {
    const { data: commit } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      { owner, repo, commit_sha: commitSha }
    );
    const tipTreeSha = commit.tree.sha;
    const { data: tree } = await octokit.request(
      "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
      { owner, repo, tree_sha: tipTreeSha, recursive: "1" }
    );
    const blobs = new Map<string, string>();
    for (const entry of tree.tree) {
      if (entry.type === "blob" && entry.path && entry.sha) {
        blobs.set(entry.path, entry.sha);
      }
    }
    return { tipTreeSha, blobs };
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
      pr?: { title: string; body: string };
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
    return this.openOrFindPr(octokit, owner, repo, slug, args.branch, args.pr);
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
    // (bug.0378). New files from the shared template (byte-exact to render-node-appset.sh) land under
    // the PER-ENV infra/k8s/argocd/appsets/<env>/ dir (each reconciled+pruned by its own per-env
    // cogni-<env>-appsets app-of-apps, story.5020), then folded into that env's appsets/<env>/
    // kustomization.yaml so the unit-job drift gate stays green.
    const appsetTemplate = await this.readFileOnMain(
      octokit,
      owner,
      repo,
      APPSET_TEMPLATE_PATH
    );
    for (const env of NODE_FORMATION_ENVS) {
      await addBlob(
        `infra/k8s/argocd/appsets/${env}/${env}-${slug}-applicationset.yaml`,
        renderNodeAppset(appsetTemplate, slug, env)
      );
      const argocdKustomization = await this.readFileOnMain(
        octokit,
        owner,
        repo,
        appsetsKustomizationPath(env)
      );
      await addBlob(
        appsetsKustomizationPath(env),
        insertAppsetKustomization(argocdKustomization, slug, env)
      );
    }

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

  private async findOpenPrForBranch(
    octokit: Octokit,
    owner: string,
    repo: string,
    input: {
      readonly branch: string;
      readonly title?: string;
    }
  ): Promise<OpenNodeAppPrResult | null> {
    const { data: existing } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner,
        repo,
        state: "open",
        head: `${owner}:${input.branch}`,
        per_page: 1,
      }
    );
    const pr = (existing as GitHubPullRequestSummary[])[0];
    if (pr) return { prNumber: pr.number, prUrl: pr.html_url };

    const { data: openPrs } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      { owner, repo, state: "open", per_page: 100 }
    );
    const expectedRepo = `${owner}/${repo}`.toLowerCase();
    const fallback = (openPrs as GitHubPullRequestSummary[]).find(
      (candidate) => {
        const headRepo = candidate.head?.repo?.full_name?.toLowerCase();
        const branchMatches = candidate.head?.ref === input.branch;
        const sameRepoOrUnknown =
          headRepo === undefined || headRepo === expectedRepo;
        return (
          (branchMatches && sameRepoOrUnknown) ||
          (input.title !== undefined && candidate.title === input.title)
        );
      }
    );
    return fallback
      ? { prNumber: fallback.number, prUrl: fallback.html_url }
      : null;
  }

  private async findMergedPrForBranch(
    octokit: Octokit,
    owner: string,
    repo: string,
    input: {
      readonly branch: string;
      readonly title?: string;
    }
  ): Promise<ActivationPrStatus> {
    const { data: closedPrs } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls",
      {
        owner,
        repo,
        state: "closed",
        sort: "updated",
        direction: "desc",
        per_page: 50,
      }
    );
    const expectedRepo = `${owner}/${repo}`.toLowerCase();
    const pr = (closedPrs as GitHubPullRequestSummary[]).find((candidate) => {
      if (!candidate.merged_at) return false;
      const headRepo = candidate.head?.repo?.full_name?.toLowerCase();
      const branchMatches = candidate.head?.ref === input.branch;
      const sameRepoOrUnknown =
        headRepo === undefined || headRepo === expectedRepo;
      return (
        (branchMatches && sameRepoOrUnknown) ||
        (input.title !== undefined && candidate.title === input.title)
      );
    });

    return pr
      ? {
          number: pr.number,
          url: pr.html_url,
          state: "merged",
          mergedAt: pr.merged_at ?? null,
          mergeCommitSha: pr.merge_commit_sha ?? null,
        }
      : null;
  }

  /**
   * Copy the monorepo's `main` branch-protection VERBATIM onto the new node repo.
   * PROTECTION_HAS_ONE_SSOT: the node inherits the EXACT required-status-check set
   * + flags the deployment monorepo enforces — the operator invents no node-specific
   * policy. This is the merge-on-green backstop GitHub enforces independently of the
   * operator's `/vcs/merge` gate. Reads the source via the App's `administration`
   * read and writes the node via the same privilege used by {@link ensureActionsEnabled}.
   * Fails loud if the source is unprotected (the monorepo MUST be the canonical
   * protected repo). Idempotent: the PUT converges on re-run.
   */
  private async replicateBranchProtection(
    sourceOctokit: Octokit,
    sourceOwner: string,
    sourceRepo: string,
    targetOctokit: Octokit,
    targetOwner: string,
    targetRepo: string
  ): Promise<void> {
    let source: ProtectionResponse;
    try {
      const { data } = await sourceOctokit.request(
        "GET /repos/{owner}/{repo}/branches/{branch}/protection",
        { owner: sourceOwner, repo: sourceRepo, branch: "main" }
      );
      source = data as ProtectionResponse;
    } catch (err) {
      if ((err as { status?: number })?.status === 404) {
        throw new Error(
          `replicateBranchProtection: source ${sourceOwner}/${sourceRepo}@main is unprotected — ` +
            `the deployment monorepo must be branch-protected before nodes can inherit it`
        );
      }
      throw err;
    }
    await targetOctokit.request(
      "PUT /repos/{owner}/{repo}/branches/{branch}/protection",
      {
        owner: targetOwner,
        repo: targetRepo,
        branch: "main",
        ...protectionGetToPutPayload(source),
      }
    );
  }

  /**
   * Set a node repo's canonical repo settings — mirrors `setup-main-branch.sh` step 1:
   *   - Merge settings: squash-only, auto-merge enabled, delete-branch-on-merge.
   *     `allow_auto_merge` is REQUIRED for the merge-queue path (`mergePr` enables
   *     auto-merge to route a PR through the queue; fails if the repo forbids it).
   *   - `is_template: false`: a node is NOT a template. Forking `node-template` (which
   *     IS a template) makes the fork inherit `is_template: true` — clear it so the node
   *     doesn't masquerade as a "Use this template" repo. Idempotent.
   */
  private async ensureCanonicalRepoSettings(
    octokit: Octokit,
    owner: string,
    repo: string
  ): Promise<void> {
    await octokit.request("PATCH /repos/{owner}/{repo}", {
      owner,
      repo,
      allow_squash_merge: true,
      allow_merge_commit: false,
      allow_rebase_merge: false,
      delete_branch_on_merge: true,
      allow_auto_merge: true,
      is_template: false,
    });
  }

  /**
   * Copy the monorepo's `merge_queue` ruleset VERBATIM onto the new node repo, so the
   * node requires the same queue the network does. PROTECTION_HAS_ONE_SSOT extends to
   * the queue: the monorepo is the source of truth.
   *
   * Unlike branch protection (which MUST exist — an unprotected node is unformed), the
   * queue is admin-opt-in on the monorepo. When the monorepo has no `merge_queue`
   * ruleset this is a clean SKIP (logged, not an error): the node mirrors the monorepo
   * and is born queue-less. Once an admin enables the queue ruleset on the monorepo,
   * every subsequently-formed node inherits it automatically. Idempotent on the target
   * (find-by-name → PUT, else POST). See docs/spec/merge-authority.md.
   */
  private async replicateMergeQueue(
    sourceOctokit: Octokit,
    sourceOwner: string,
    sourceRepo: string,
    targetOctokit: Octokit,
    targetOwner: string,
    targetRepo: string
  ): Promise<void> {
    // 1. Find the queue ruleset on the source (summary list has no rules; match by name).
    const { data: sourceRulesets } = await sourceOctokit.request(
      "GET /repos/{owner}/{repo}/rulesets",
      { owner: sourceOwner, repo: sourceRepo }
    );
    const summary = (
      sourceRulesets as ReadonlyArray<{ id: number; name: string }>
    ).find((r) => r.name === MERGE_QUEUE_RULESET_NAME);
    if (!summary) {
      // Source has no `main-merge-queue` ruleset — the queue is admin-opt-in on the
      // monorepo and not yet enabled. Clean skip: the node mirrors the monorepo and is
      // born queue-less. Re-runs once the monorepo gains the ruleset will replicate it.
      return;
    }

    // 2. GET the full ruleset (with rules + parameters) and build the write payload.
    const { data: full } = await sourceOctokit.request(
      "GET /repos/{owner}/{repo}/rulesets/{ruleset_id}",
      { owner: sourceOwner, repo: sourceRepo, ruleset_id: summary.id }
    );
    const payload = rulesetGetToPutPayload(full as RulesetResponse);

    // 3. Idempotent apply on the target: PUT if a same-named ruleset exists, else POST.
    const { data: targetRulesets } = await targetOctokit.request(
      "GET /repos/{owner}/{repo}/rulesets",
      { owner: targetOwner, repo: targetRepo }
    );
    const existing = (
      targetRulesets as ReadonlyArray<{ id: number; name: string }>
    ).find((r) => r.name === MERGE_QUEUE_RULESET_NAME);
    try {
      if (existing) {
        await this.requestRaw(
          targetOctokit,
          "PUT /repos/{owner}/{repo}/rulesets/{ruleset_id}",
          {
            owner: targetOwner,
            repo: targetRepo,
            ruleset_id: existing.id,
            ...payload,
          }
        );
      } else {
        await this.requestRaw(
          targetOctokit,
          "POST /repos/{owner}/{repo}/rulesets",
          { owner: targetOwner, repo: targetRepo, ...payload }
        );
      }
    } catch (err) {
      // QUEUE_IS_BEST_EFFORT: the `merge_queue` ruleset rule is an organization /
      // GitHub-Team feature — a node minted under a PERSONAL account (or a plan
      // without it) returns 403/422 (verified against GitHub: same payload accepted
      // on an org repo, rejected on a personal one). The queue is an enhancement, not
      // the merge-on-green backstop (branch protection is), so a node that cannot
      // carry it is still a formed node: skip, don't fail formation. Other errors
      // (auth, network) are real — rethrow.
      const status = (err as { status?: number })?.status;
      if (status === 403 || status === 422) return;
      throw err;
    }
  }

  /**
   * Issue a GitHub request through octokit's LOOSE (`route: string`) overload. The
   * generated rulesets write-params (enum unions, discriminated rule parameters) are
   * stricter than our verbatim-copied `RulesetWritePayload`, which is runtime-correct
   * but not statically assignable to them. Typing `route` as `string` selects the
   * generic overload whose body is `RequestParameters`, accepting the dynamic payload.
   */
  private async requestRaw(
    octokit: Octokit,
    route: string,
    params: Record<string, unknown>
  ): Promise<void> {
    await octokit.request(route, params);
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
    branch: string,
    pr?: { title: string; body: string }
  ): Promise<OpenNodeAppPrResult> {
    const title = pr?.title ?? `feat(node): bootstrap node-app for ${slug}`;
    const body =
      pr?.body ??
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
      const pr = await this.findOpenPrForBranch(octokit, owner, repo, {
        branch,
        title,
      });
      if (!pr) {
        throw new Error(
          `Failed to open node-app PR and no open PR found for head ${branch}`
        );
      }
      return pr;
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
