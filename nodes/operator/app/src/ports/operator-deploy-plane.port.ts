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
 *     through a code-branch PR. Preview AND production share ONE method (`promoteNode`),
 *     differing only by dispatched `env` + the route's authz. Both are SOURCE-ADDRESSED by the
 *     node image sha (`node_source_sha` input, like candidate-flight) for REMOTE-SOURCE (fork)
 *     nodes: the workflow resolves the image from the input and records the pin on the env deploy
 *     branch, writing ZERO commits to `main` (task.5022; the App's main-write privilege is reserved
 *     for governance/code merges). IN-REPO nodes (no catalog `source_repo`) are not source-addressed
 *     by node sha — they pass `source_sha` (the operator checkout ref) instead.
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

export interface PromoteNodeInput {
  /** Target rung. Same code path for both — only the dispatched env + the route's authz differ. */
  readonly env: "preview" | "production";
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly slug: string;
  /**
   * Node-repo commit SHA to promote — the build the node's PR CI published as `sha-<sourceSha>`.
   * For a REMOTE-SOURCE (fork) node this source-addresses the image (`node_source_sha`). For an
   * IN-REPO node it is the operator checkout ref (`source_sha`); never crossed between the two.
   */
  readonly sourceSha: string;
}

export interface NodePromoteResult {
  /**
   * Always `dispatched`: every rung source-addresses the node sha on the dispatch (no main write,
   * no PR), so there is no `already_pinned` branch — the pin lands on `deploy/<env>` as part of the
   * promote run.
   */
  readonly status: "dispatched";
  /** Rung the dispatch targeted. */
  readonly env: "preview" | "production";
  /** SHA promoted — `node_source_sha` (remote-source) or `source_sha` (in-repo). */
  readonly sourceSha: string;
  /** `remote_source` when source-addressed by node sha; `in_repo` when passing the checkout ref. */
  readonly sourceAddressing: "remote_source" | "in_repo";
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
  /**
   * Tier-3 (node identity / presentation) globs to carve OUT of the upstream merge — the fork's own
   * version of these paths is restored before the PR opens, so node-template's starter
   * presentation/branding/identity never overwrites a fork's. Declared in node-template's
   * `.cogni/sync-manifest.yaml#node_local` (TIER3_IS_DATA); the caller resolves it and passes it here.
   * Empty/omitted ⇒ no carve-out (legacy whole-repo merge behavior).
   */
  readonly nodeLocalPaths?: readonly string[];
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

export interface ResolveNodeRepoInput {
  /** Parent monorepo owner — `NODE_SUBMODULE_PARENT_OWNER`. */
  readonly parentOwner: string;
  /** Parent monorepo repo — `NODE_SUBMODULE_PARENT_REPO`. */
  readonly parentRepo: string;
  /** Resolved node slug (`infra/catalog/<slug>.yaml`). */
  readonly slug: string;
}

export interface ResolvedNodeRepo {
  /** Node source repo owner, parsed from the catalog row's `source_repo`. */
  readonly owner: string;
  /** Node source repo name. */
  readonly repo: string;
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
   *
   * THREE_TIER_CARVE_OUT (spec.repo-sync-contract): `nodeLocalPaths` (Tier 3 — node identity /
   * presentation) are restored to the FORK's version before the PR opens, so the upstream PR carries
   * only Tier-2 substrate (`build their mission, not their plumbing`). With Tier 3 out of the diff the
   * merge stops conflicting on node-local UI/branding/identity, so Tier 1 + Tier 2 are always
   * auto-mergeable. node-template is a starter only — its presentation never overwrites a fork's.
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

  /**
   * Resolve the Tier-3 (node identity / presentation) globs from the template repo's
   * `.cogni/sync-manifest.yaml#node_local` at `sourceRef` (TIER3_IS_DATA — declared in node-template,
   * read at runtime). Falls back to the hardcoded default floor when the manifest is missing or carries
   * no `node_local:` block, so the carve-out is always at least the obvious presentation surface.
   * The facade resolves this once per sync and threads it into every fork's Tier-2 merge.
   */
  resolveNodeLocalPaths(input: {
    readonly sourceOwner: string;
    readonly sourceRepo: string;
    readonly sourceRef: string;
  }): Promise<readonly string[]>;

  /**
   * Resolve a node's OWN source repo (`{owner, repo}`) from the parent monorepo's
   * `infra/catalog/<slug>.yaml` `source_repo` (read via the App — the catalog is absent on the
   * operator's runtime disk). The node-scoped VCS routes (`approve-checks`, `merge`) target the
   * node's repo, not the monorepo. Throws a coded `catalog_missing` (404) when the row is absent —
   * the merge route catches it to fall back to the monorepo (legacy lane); approve-checks surfaces it.
   */
  resolveNodeRepo(input: ResolveNodeRepoInput): Promise<ResolvedNodeRepo>;

  /**
   * Grant a GitHub identity branch-push (Write) on a node repo — the operator App as the privilege
   * bridge for the contributor golden path (rbac.md §6a, TRUST_BOUNDARY_IS_MERGE_NOT_PUSH). The App
   * holds `administration: write`; the agent never holds standing GitHub admin. Idempotent (re-granting
   * is a GitHub no-op). Returns the invitation id when GitHub creates a pending invite — an outside
   * collaborator the agent then auto-accepts with its own token (rbac.md §6 step 5) — else null
   * (applied immediately for an org member / existing collaborator).
   */
  setNodeCollaborator(input: {
    owner: string;
    repo: string;
    login: string;
    permission?: "pull" | "triage" | "push" | "maintain" | "admin";
  }): Promise<{ invitationId: number | null }>;

  /**
   * Revoke a node-repo collaborator (rbac.md §6a de-provision, on access reject/revoke). Idempotent:
   * a 404 (already not a collaborator) is treated as success so revocation is safe to retry.
   */
  removeNodeCollaborator(input: {
    owner: string;
    repo: string;
    login: string;
  }): Promise<void>;

  dispatchNodeRefCandidateFlight(input: {
    owner: string;
    repo: string;
    slug: string;
    sourceSha: string;
  }): Promise<CandidateFlightDispatchResult>;

  /**
   * Dispatch `pr-build.yml` (workflow_dispatch) in the BASE repo for a TRUSTED build of an approved
   * PR head. A fork contributor's `pull_request` run is read-only (GitHub's fork-PR security model)
   * so it can't push — this operator-dispatched run (base repo, packages:write) builds the tree at
   * `headRepo@headSha` and pushes the same `sha-<headSha>` image candidate-flight resolves. It is the
   * BUILD half of `run-ci`. RBAC (`node.flight`) is enforced at the route BEFORE this is called.
   * Reuses the SAME pr-build workflow — no new workflow, no fork-build lane (the purged abstraction
   * stays purged; the capability lives in pr-build.yml itself).
   */
  dispatchPrBuild(input: {
    owner: string;
    repo: string;
    headRepo: string;
    headSha: string;
    prNumber: number;
  }): Promise<CandidateFlightDispatchResult>;

  /**
   * Promote a node to preview OR production — ONE code path, ONE_PROMOTION_PRIMITIVE. The rung
   * differs only by the dispatched `env` + the route's authz (preview is the ungated node-merge
   * hook; production is RBAC-gated on `node.promote_production`, enforced BEFORE this is called).
   *
   * Reads the parent catalog row via the App (it is absent on the operator's runtime disk) ONLY to
   * DISCRIMINATE the node kind — it reads `source_repo` PRESENCE, never `source_sha`, for resolution:
   *   - REMOTE-SOURCE (catalog has `source_repo`, e.g. beacon): source-addressed by the node sha
   *     (`node_source_sha`), NO `source_sha`. The catalog `source_sha` is birth-only metadata,
   *     never a deploy authority here.
   *   - IN-REPO (no `source_repo`, e.g. operator/poly): NOT source-addressed by node sha — passes
   *     `source_sha` (the operator checkout ref).
   * Dispatches `promote-and-deploy.yml`; the pin lands on `deploy/<env>` (`update-source-sha-map.sh`).
   * Writes ZERO commits to `main`. `skip_infra=true` (APP_PROMOTE_IS_NO_INFRA) is set by the dispatch.
   */
  promoteNode(input: PromoteNodeInput): Promise<NodePromoteResult>;

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
