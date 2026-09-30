// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/deploy-plane`
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

/** A workflow dispatch GitHub has acknowledged with a concrete Actions run. */
export interface ObservedWorkflowDispatchResult
  extends CandidateFlightDispatchResult {
  readonly runId: number;
  readonly runUrl: string;
  readonly runApiUrl: string;
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
   * Canonical commit SHA on the source repository's main branch. For a REMOTE-SOURCE (fork) node
   * this source-addresses the image (`node_source_sha`). For an IN-REPO node it is the operator
   * checkout ref (`source_sha`); never crossed between the two.
   */
  readonly sourceSha: string;
  /** Explicit authorized escape hatch for a deliberate rollback to an older commit on main. */
  readonly allowRollback?: boolean;
}

export interface PromoteNodeFromPreviewInput {
  readonly parentOwner: string;
  readonly parentRepo: string;
  readonly slug: string;
  /** Explicit authorized escape hatch for a deliberate rollback to an older commit on main. */
  readonly allowRollback?: boolean;
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
  /** Native run identity proves GitHub created the workflow run; a bare 204 is not success. */
  readonly runId: number;
  readonly runUrl: string;
  readonly runApiUrl: string;
}

export type ReconcileNodeInfraInput =
  | {
      /** Existing production full-infra replay; the caller cannot select its source. */
      readonly env: "production";
      readonly parentOwner: string;
      readonly parentRepo: string;
      /** Node whose production-promoter grant authorized the shared infra operation. */
      readonly slug: string;
    }
  | {
      /** Candidate control-plane desired-state selection; never dispatches a workflow. */
      readonly env: "candidate-a";
      readonly parentOwner: string;
      readonly parentRepo: string;
      /** Shared control-plane authority is scoped to the operator node. */
      readonly slug: "operator";
      /** Exact head SHA of an open, same-repo PR to main. */
      readonly sourceSha: string;
    };

export type NodeInfraReconcileResult =
  | {
      readonly status: "dispatched";
      readonly env: "production";
      /** Existing deployed source pin reused so the infra reconcile cannot advance the app. */
      readonly sourceSha: string;
      readonly sourceAddressing: "remote_source" | "in_repo";
      readonly workflowUrl: string;
    }
  | {
      readonly status: "updated" | "unchanged";
      readonly env: "candidate-a";
      readonly lane: "control_plane";
      /** Reviewed PR head whose tree is selected as candidate control-plane desired state. */
      readonly sourceSha: string;
      /** Commit currently at the control-plane deploy ref (may be a synthetic lease commit). */
      readonly deploySha: string;
      readonly deployRef: "deploy/candidate-a-control-plane";
      readonly refUrl: string;
      readonly prNumber: number;
      readonly prUrl: string;
    }
  | {
      readonly status: "dispatched";
      readonly env: "candidate-a";
      readonly lane: "compose";
      readonly sourceSha: string;
      /** Native identity returned by GitHub's versioned workflow-dispatch API. */
      readonly runId: number;
      readonly runUrl: string;
      readonly runApiUrl: string;
      readonly prNumber: number;
      readonly prUrl: string;
    };

/**
 * Merged catalog intent needed to project one node into every environment's local registry.
 * The stable values come from git; `ownerWallet` is resolved to a different users.id per DB.
 */
export interface CatalogNodeDefinition {
  readonly nodeId: string;
  readonly slug: string;
  readonly repoUrl: string;
  readonly repoOwner: string;
  readonly repoName: string;
  readonly deployEnvs: readonly ("candidate-a" | "preview" | "production")[];
  readonly activityEnv: "candidate-a" | "preview" | "production";
  readonly ownerWallet: string;
  /**
   * The row's `deployment_provider` — WHERE this node's app runs, per environment. Projected into
   * the registry so the operator can resolve a node's address from declared placement instead of
   * assuming every node is a cluster neighbour (bug.5106). An omitted environment is `k3s`
   * (K3S_IS_DEFAULT). The union is mirrored (not imported) from
   * `@shared/node-registry/placement` — `ports` may not import `shared`.
   */
  readonly deploymentProviders: Readonly<
    Partial<
      Record<
        "candidate-a" | "preview" | "production",
        "k3s" | "akash" | undefined
      >
    >
  >;
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

/** Input to `classifyEnvManagerPr` — a PR addressed in the parent monorepo. */
export interface ClassifyEnvManagerPrInput {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
}

/**
 * Whether a monorepo PR is an App-signed `cogni.env-manager.v1` env-membership PR (structurally
 * identical to `@/shared/vcs/env-manager-pr` `EnvManagerPrClassification` — declared here because
 * the ports layer may not import shared).
 */
export interface EnvManagerPrClassificationResult {
  readonly isEnvManagerPr: boolean;
  /** The `Cogni-Node` trailer value — the node whose env membership the PR changes. */
  readonly targetNodeRef?: string;
}

export interface DeployPlanePort {
  prepareNodeRefCandidateFlight(
    input: PrepareNodeRefCandidateFlightInput
  ): Promise<PreparedNodeRefCandidateFlight>;

  /**
   * App-read every merged `type:node` catalog row for registry projection. Includes operator +
   * node-template and fails loud on a malformed node row: one bad file must never be mistaken for
   * an empty catalog.
   */
  listCatalogNodes(input: {
    readonly parentOwner: string;
    readonly parentRepo: string;
    /** Exact deployed operator revision whose catalog is being projected. */
    readonly sourceRef: string;
  }): Promise<readonly CatalogNodeDefinition[]>;

  /**
   * Resolve a node's OWN source repo (`{owner, repo}`) from the parent monorepo's
   * `infra/catalog/<slug>.yaml` `source_repo` (read via the App — the catalog is absent on the
   * operator's runtime disk). The node-scoped VCS routes (`approve-checks`, `merge`) target the
   * node's repo, not the monorepo. Throws a coded `catalog_missing` (404) when the row is absent —
   * the merge route catches it to fall back to the monorepo (legacy lane); approve-checks surfaces it.
   */
  resolveNodeRepo(input: ResolveNodeRepoInput): Promise<ResolvedNodeRepo>;

  /**
   * Classify a monorepo PR as an App-signed env-membership PR (`cogni.env-manager.v1`) or not.
   * Fetches the PR + its HEAD commit via the App and applies the pure classifier
   * (`@/shared/vcs/env-manager-pr`): reserved branch family, single `Cogni-Change-Type` +
   * `Cogni-Node` trailers, and an App signature (`verified && reason==="valid"`, one parent).
   * The env-membership verb authors these signed PRs into the parent monorepo, so the merge
   * route resolves the repo from `nodeId:operator` as usual and uses this ONLY to decide WHO may
   * authorize: an env-manager PR is authorized by `node.manage_envs` on its `targetNodeRef`
   * instead of `node.flight` on the operator. NEVER throws for a non-env PR — a look-alike that
   * fails any gate returns `{ isEnvManagerPr: false }`, and the route additionally fail-closes on
   * any thrown error (treats it as not-env-manager).
   */
  classifyEnvManagerPr(
    input: ClassifyEnvManagerPrInput
  ): Promise<EnvManagerPrClassificationResult>;

  /**
   * Read a text file from a repo via the operator App (contents:read). Returns null when the file is
   * absent. Used by the attribution-profile resolver to read each node's `.cogni/repo-spec.yaml`
   * (`source_refs`) — the same App-auth catalog/spec read path resolveNodeRepo uses; the file is
   * absent on the operator's runtime disk, so this App path is the only runtime source.
   */
  fetchFileText(input: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null>;

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
   * Promote preview's exact digest to production after validating its recorded source SHA against
   * the node repository and current production pin. The workflow remains preview-forward so the
   * accepted digest is copied rather than rebuilt or re-resolved from a mutable tag.
   */
  promoteNodeFromPreview(
    input: PromoteNodeFromPreviewInput
  ): Promise<CandidateFlightDispatchResult>;

  /**
   * The sha an environment is ACTUALLY running for one node: `<slug>` in
   * `.promote-state/source-sha-by-app.json` on `deploy/<env>-<slug>` — the pin every promote and
   * every candidate flight writes (`scripts/ci/update-source-sha-map.sh`). This is the ONLY
   * runtime-readable statement of deployed truth: promotion writes ZERO commits to `main`, so
   * `main` cannot carry it (task.5022 retired that firehose).
   *
   * Returns `null` when the node has never deployed to that env — a BIRTH lane, the one case where
   * the catalog row's `source_sha` is a legitimate stand-in. Anywhere else, reading the catalog for
   * a deploy sha reverts a live env to its birth pin (bug.5043, re-observed as bug.5237).
   */
  readNodeDeployPin(input: {
    parentOwner: string;
    parentRepo: string;
    env: string;
    slug: string;
  }): Promise<string | null>;

  /**
   * Existing deploy authority for shared infrastructure. Production replays the current app pin
   * through the full-infra workflow. Candidate-a classifies a reviewed PR into exactly one lane:
   * Compose/edge dispatches the existing candidate infra workflow, while control-plane changes
   * select the dedicated `deploy/candidate-a-control-plane` GitOps ref. Both preserve app digests;
   * callers cannot select a lane, repo, arbitrary ref, workflow, or mode. Authorization is enforced
   * at the route before this method is called. Shared infra is operator-node scoped in v0.
   */
  reconcileNodeInfra(
    input: ReconcileNodeInfraInput
  ): Promise<NodeInfraReconcileResult>;

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
  }): Promise<ObservedWorkflowDispatchResult>;
}
