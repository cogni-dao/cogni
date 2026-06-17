// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-deploy-plane`
 * Purpose: Operator-local deploy control plane for candidate flight dispatch.
 * Scope: Interface only. Keeps hosted deploy operations out of shared AI-tool capabilities.
 * Invariants:
 *   - OPERATOR_OWNS_DEPLOY: deploy mutations target the operator parent repo/workflows.
 *   - NODE_REF_ARTIFACT_GATE: node-ref flight dispatch requires a resolvable source artifact.
 *   - ONE_PROMOTION_PRIMITIVE: every promotion rung (candidate-a, preview, production)
 *     dispatches `promote-and-deploy.yml` directly via the operator App — no rung routes
 *     through a code-branch PR. Preview is SOURCE-ADDRESSED by the node image sha
 *     (`node_source_sha` input, like candidate-flight): the workflow resolves the image from
 *     the input and records the pin on `deploy/preview`, writing ZERO commits to `main`
 *     (task.5022; the App's main-write privilege is reserved for governance/code merges).
 * Side-effects: none
 * Links: docs/spec/node-ci-cd-contract.md, src/app/api/v1/vcs/flight/route.ts
 * @public
 */

export interface CandidateFlightDispatchResult {
  readonly dispatched: boolean;
  readonly workflowUrl: string;
  readonly message: string;
}

export interface PrepareNodeRefCandidateFlightInput {
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
}

export interface PreparedNodeRefCandidateFlight {
  readonly nodeId: string;
  readonly slug: string;
  readonly sourceSha: string;
  readonly sourceRepo: string;
  readonly image: string;
}

export interface PromoteNodeToPreviewInput {
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly slug: string;
  /** Node-repo PR head commit SHA — the build the node's PR CI published as `sha-<sourceSha>`. */
  readonly sourceSha: string;
}

export interface NodePreviewPromoteResult {
  /**
   * Always `dispatched`: preview mirrors production (ONE_PROMOTION_PRIMITIVE). The node sha is
   * source-addressed on the dispatch (no main write, no PR), so there is no `already_pinned`
   * branch — the pin lands on `deploy/preview` as part of the promote run.
   */
  readonly status: "dispatched";
  /** Node-repo PR head SHA promoted — the `node_source_sha` the workflow pins. */
  readonly sourceSha: string;
  readonly workflowUrl: string;
}

export interface MirrorCanonicalFilesInput {
  /** Canonical source repo owner (the template), e.g. `Cogni-DAO`. */
  readonly sourceOwner: string;
  /** Canonical source repo, e.g. `node-template`. */
  readonly sourceRepo: string;
  /** Source ref to read canonical content at — a 40-char SHA or a branch name (e.g. `main`). */
  readonly sourceRef: string;
  /** Target fork repo owner (a catalog `source_repo` row owner). */
  readonly targetOwner: string;
  /** Target fork repo (a catalog `source_repo` row repo). */
  readonly targetRepo: string;
  /** Target node slug — used only for the mirror PR title/labelling. */
  readonly slug: string;
  /**
   * Canonical paths to mirror byte-for-byte. Any operator-scope node-template content the caller
   * declares — CI workflows, scripts, package manifests, configs. The set is a caller concern
   * (P2 sources it from the sync manifest); this method mirrors whatever it is given.
   */
  readonly canonicalPaths: readonly string[];
}

export type MirrorCanonicalFilesResult =
  | {
      readonly status: "no_changes";
      readonly branch: string;
      readonly changedPaths: readonly string[];
    }
  | {
      readonly status: "pr_opened";
      readonly branch: string;
      readonly prNumber: number;
      readonly prUrl: string;
      readonly changedPaths: readonly string[];
    };

export interface SyncTemplateUpstreamInput {
  /** Template (upstream/parent) repo owner, e.g. `Cogni-DAO` — for PR copy only. */
  readonly templateOwner: string;
  /** Template repo, e.g. `node-template` — for PR copy only. */
  readonly templateRepo: string;
  /** The upstream commit SHA to merge (node-template's pushed main tip). Reachable in the fork network. */
  readonly templateSha: string;
  /** Fork (child node) repo owner. */
  readonly forkOwner: string;
  /** Fork repo = node slug. */
  readonly forkRepo: string;
  /** Fork base branch the upstream merges into, e.g. `main`. */
  readonly forkBranch: string;
}

export type SyncTemplateUpstreamResult =
  | { readonly status: "up_to_date" }
  | {
      readonly status: "pr_opened";
      readonly prNumber: number;
      readonly prUrl: string;
    };

export interface CatalogForkTarget {
  /** Fork repo owner, parsed from the catalog row's `source_repo`. */
  readonly owner: string;
  /** Fork repo name. */
  readonly name: string;
  /** Catalog slug (the `<slug>.yaml` filename). */
  readonly slug: string;
}

export interface OperatorDeployPlanePort {
  prepareNodeRefCandidateFlight(
    input: PrepareNodeRefCandidateFlightInput
  ): Promise<PreparedNodeRefCandidateFlight>;

  /**
   * Enumerate the child node FORKS from the parent monorepo's `infra/catalog/*.yaml` `source_repo` rows
   * (read via the App — the catalog is absent on the operator's runtime disk). This is the env-aligned
   * SSOT: the parent is `NODE_SUBMODULE_PARENT_{OWNER,REPO}` (cogni-test-org/cogni-monorepo on candidate-a,
   * Cogni-DAO/cogni on prod), so the forks are exactly the repos the env's App can write. Excludes
   * `node-template` (the mirror source) and `operator` (the hub). Used to target the fork sync — NOT the
   * `nodes` table (wizard-spawn state, may not contain catalog-declared forks) and NOT the node registry.
   */
  listCatalogForkTargets(input: {
    readonly parentOwner: string;
    readonly parentRepo: string;
  }): Promise<readonly CatalogForkTarget[]>;

  /**
   * Tier 2 (optional, customization-preserving): open a cross-fork PR `templateOwner:templateBranch`
   * → the fork's base branch, so node-template's app/graphs/runtime improvements reach the fork as a
   * **merge** the fork reviews — never an overwrite. Relies on the shared merge-base a node fork keeps
   * with node-template (node-ci-cd-contract §Forward path), so the PR carries only upstream deltas and
   * preserves fork customizations (`FORK_FREEDOM`, `POLICY_STAYS_LOCAL`). `up_to_date` when no commits
   * separate the fork from upstream. Distinct from `syncCanonicalFilesToFork` (Tier 1): that surgically
   * overwrites the flight-contract files so a CI fix lands cleanly even when this merge conflicts.
   */
  syncTemplateUpstreamToFork(
    input: SyncTemplateUpstreamInput
  ): Promise<SyncTemplateUpstreamResult>;

  /**
   * Forward-mirror a declared canonical file set from the template repo to one fork repo,
   * opening (or updating) exactly one PR. The set is whatever `canonicalPaths` the caller
   * declares — any operator-scope node-template content (CI workflows, scripts, package
   * manifests, configs), not CI alone. Reads each `canonicalPaths` entry at `sourceRef`,
   * diffs against the fork's `main`, and commits only the changed files as a single tree.
   *
   * Invariants:
   *   - FORWARD_MIRROR_INDEPENDENT_OF_DETECTOR: this is the node-template→forks axis. It does NOT
   *     consume the hub↔artifact `sync-drift-detector` signal; `node-template` is the mirror SOURCE,
   *     never a detector artifact. Keep the two propagation directions decoupled.
   *   - BRANCH_IS_IDEMPOTENCY_KEY: the head branch is derived from the resolved source SHA, so a
   *     re-run on the same canonical version updates the same PR instead of opening a second one.
   *   - CHANGED_ONLY: byte-identical files produce no tree entry; an all-identical fork is `no_changes`.
   */
  syncCanonicalFilesToFork(
    input: MirrorCanonicalFilesInput
  ): Promise<MirrorCanonicalFilesResult>;

  dispatchNodeRefCandidateFlight(input: {
    owner: string;
    repo: string;
    slug: string;
    sourceSha: string;
  }): Promise<CandidateFlightDispatchResult>;

  /**
   * On a node-repo PR merge: promote the node to preview the same way production promotes
   * (ONE_PROMOTION_PRIMITIVE), source-addressed by the node head sha. Dispatches
   * `promote-and-deploy.yml` at env=preview with `node_source_sha` so the workflow resolves the
   * node image from the input (not a catalog read) and records the pin on `deploy/preview`.
   * Writes ZERO commits to `main`. Validates that the parent catalog row exists/identifies the
   * slug but reads nothing from it for resolution.
   */
  promoteNodeToPreview(
    input: PromoteNodeToPreviewInput
  ): Promise<NodePreviewPromoteResult>;

  /**
   * Promote a node to an environment by dispatching `promote-and-deploy.yml` via the operator App.
   * Authorization (`node.promote_production` for prod) is enforced at the route BEFORE this is called.
   * `sourceSha` is the operator-repo checkout ref (optional — omit it for production preview-forward
   * mode); never pass a child SHA there. `nodeSourceSha` source-addresses a remote-source node's
   * image (preview promote): present ⇒ the workflow pins it; absent ⇒ the workflow reads the catalog
   * `source_sha` pin (`CATALOG_SOURCE_SHA_IS_THE_DEPLOY_PIN`, production unchanged).
   */
  dispatchNodePromote(input: {
    owner: string;
    repo: string;
    env: string;
    slug: string;
    sourceSha?: string;
    nodeSourceSha?: string;
  }): Promise<CandidateFlightDispatchResult>;
}
