// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/vcs/env-manager-pr`
 * Purpose: Pure classifier that decides whether a monorepo PR is an operator-authored,
 *   App-signed env-membership PR (`cogni.env-manager.v1`) — the signed catalog change the
 *   `POST /nodes/{id}/envs` verb opens into the parent monorepo. Used by the merge route to
 *   authorize an `env_manager` to merge ITS OWN env PR via `node.manage_envs` on the target
 *   node, WITHOUT `node.flight` on the operator (task.5141).
 * Scope: One total, IO-free decision over already-fetched PR/commit facts. The adapter fetches
 *   the PR + HEAD commit and hands the facts here; the route never sees GitHub.
 * Invariants:
 *   - BRANCH_FAMILY_RESERVED: head branch MUST match `cogni-operator/node-env-<slug>-<env>`
 *     (byte-identical to `lane-onboard.server` VERB_BRANCH / `github-repo-write` nodeEnvBranch),
 *     and the branch slug MUST equal the `Cogni-Node` trailer (no branch/trailer mismatch).
 *   - SIGNED_TYPE_CLAIMED: the HEAD commit MUST carry the trailers
 *     `Cogni-Change-Type: cogni.env-manager.v1` and a single valid `Cogni-Node: <slug>`
 *     (produced by `envManagerCommitMessage`).
 *   - APP_SIGNATURE_IS_ANTI_SPOOF: the HEAD commit MUST be App-signed — `verified === true`,
 *     `reason === "valid"`, and exactly ONE parent — the same check `classify-env-manager-fast-
 *     path.sh` enforces. A verified signature is NECESSARY but NOT SUFFICIENT: GitHub marks a
 *     commit signed with ANY contributor's own verified key `verified:true`, so signature alone
 *     would let a `node.manage_envs` holder open a fork PR with the reserved branch+trailers +
 *     their own GPG key and steal `bypassQueue`. The identity gate below closes that.
 *   - IDENTITY_IS_THE_OPERATOR_BOT (parity with classify-env-manager-fast-path.sh:170-192): the PR
 *     MUST be OPEN, based on `main`, OPENED by the exact operator App bot (`login`/`id`/`type:Bot`),
 *     with its HEAD branch on the MONOREPO ITSELF (never a fork, case-insensitive full_name match)
 *     and exactly ONE commit; and the signed HEAD commit's own GitHub author MUST be that same
 *     operator bot (`login`/`id`). The bot identity + monorepo are resolved by the adapter (App
 *     `GET /app` slug → bot user), never hardcoded here — the classifier stays pure.
 *   - FAIL_CLOSED: any missing/duplicate trailer, unsigned commit, branch mismatch, fork head,
 *     non-bot opener/author, wrong base, or multi-commit PR returns `{ isEnvManagerPr: false }` —
 *     the caller then keeps the ordinary `node.flight` gate.
 * Side-effects: none (pure)
 * Links: nodes/operator/app/src/app/api/v1/vcs/merge/route.ts,
 *   nodes/operator/app/src/app/_facades/deploy/lane-onboard.server.ts,
 *   nodes/operator/app/src/adapters/server/vcs/github-repo-write.ts (envManagerCommitMessage),
 *   scripts/ci/classify-env-manager-fast-path.sh
 * @public
 */

/** The reserved change-type trailer value minted by `envManagerCommitMessage`. */
export const ENV_MANAGER_CHANGE_TYPE = "cogni.env-manager.v1";

/**
 * The verb's branch family — byte-identical to `lane-onboard.server` VERB_BRANCH and
 * `github-repo-write` `nodeEnvBranch`. Group 1 is the node slug, group 2 the env.
 */
export const ENV_MANAGER_VERB_BRANCH =
  /^cogni-operator\/node-env-(.+)-(candidate-a|preview|production)$/;

/** A valid node slug (mirrors the fast-path script's `^[a-z0-9][a-z0-9-]{0,62}$`). */
const NODE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Already-fetched facts about a PR + its HEAD commit — the adapter supplies these. */
export interface EnvManagerCommitFacts {
  /** PR head branch ref (e.g. `cogni-operator/node-env-spawny-boi-candidate-a`). */
  readonly headRef: string;
  /** Full HEAD commit message (subject + trailers). */
  readonly commitMessage: string;
  /** GitHub commit signature verification `verified` flag. */
  readonly verified: boolean;
  /** GitHub commit signature verification `reason` (e.g. `"valid"`). */
  readonly verificationReason: string | null;
  /** Number of parents of the HEAD commit (a single-parent commit → 1). */
  readonly parentCount: number;

  // --- PR identity (parity with classify-env-manager-fast-path.sh:170-181). ---
  /** PR `.state` — MUST be `"open"`. */
  readonly prState: string | null;
  /** PR `.base.ref` — MUST be `"main"`. */
  readonly baseRef: string | null;
  /** PR `.user.login` — MUST equal the operator bot login. */
  readonly prUserLogin: string | null;
  /** PR `.user.id` — MUST equal the operator bot id. */
  readonly prUserId: number | null;
  /** PR `.user.type` — MUST be `"Bot"`. */
  readonly prUserType: string | null;
  /** PR `.head.repo.full_name` — MUST be the monorepo itself (case-insensitive), never a fork. */
  readonly headRepoFullName: string | null;
  /** PR `.commits` — MUST be exactly 1. */
  readonly commitCount: number;

  // --- HEAD commit GitHub author (parity with classify-env-manager-fast-path.sh:183-189). ---
  /** HEAD commit `.author.login` (linked GitHub account) — MUST equal the operator bot login. */
  readonly commitAuthorLogin: string | null;
  /** HEAD commit `.author.id` (linked GitHub account) — MUST equal the operator bot id. */
  readonly commitAuthorId: number | null;

  // --- Trusted expectations resolved by the adapter (NOT hardcoded, keeps the classifier pure). ---
  /** The operator App bot login this deployment trusts (`<app-slug>[bot]`). */
  readonly expectedBotLogin: string;
  /** The operator App bot user id this deployment trusts. */
  readonly expectedBotId: number;
  /** The monorepo `<owner>/<repo>` the signed PR's head MUST live on (compared case-insensitively). */
  readonly expectedHeadRepoFullName: string;
}

/** Outcome of classification: whether it is an env-manager PR and, if so, its target node. */
export interface EnvManagerPrClassification {
  readonly isEnvManagerPr: boolean;
  /** The `Cogni-Node` trailer value — the node whose env membership the PR changes. */
  readonly targetNodeRef?: string;
}

/**
 * Read a trailer that MUST appear exactly once (mirrors `trailer_value` in
 * `classify-env-manager-fast-path.sh`: a duplicate or missing trailer is a rejected claim).
 */
function singleTrailer(message: string, key: string): string | null {
  const prefix = `${key}: `;
  const values = message
    .split("\n")
    .filter((line) => line.startsWith(prefix))
    .map((line) => line.slice(prefix.length));
  return values.length === 1 ? (values[0] ?? null) : null;
}

/**
 * Decide whether the fetched PR/commit facts describe an App-signed `cogni.env-manager.v1` PR.
 * Total and fail-closed: every gate must pass, else `{ isEnvManagerPr: false }`.
 */
export function classifyEnvManagerCommit(
  facts: EnvManagerCommitFacts
): EnvManagerPrClassification {
  const branchMatch = ENV_MANAGER_VERB_BRANCH.exec(facts.headRef);
  const branchSlug = branchMatch?.[1];
  if (!branchSlug) return { isEnvManagerPr: false };

  // SIGNED_TYPE_CLAIMED: reserved change-type + a single valid node trailer.
  if (
    singleTrailer(facts.commitMessage, "Cogni-Change-Type") !==
    ENV_MANAGER_CHANGE_TYPE
  ) {
    return { isEnvManagerPr: false };
  }
  const node = singleTrailer(facts.commitMessage, "Cogni-Node");
  if (!node || !NODE_SLUG_PATTERN.test(node) || node !== branchSlug) {
    return { isEnvManagerPr: false };
  }

  // APP_SIGNATURE_IS_ANTI_SPOOF: exact style of classify-env-manager-fast-path.sh:190.
  if (
    facts.verified !== true ||
    facts.verificationReason !== "valid" ||
    facts.parentCount !== 1
  ) {
    return { isEnvManagerPr: false };
  }

  // IDENTITY_IS_THE_OPERATOR_BOT (PR side) — parity with classify-env-manager-fast-path.sh:170-181.
  // A verified signature alone is insufficient: only the exact operator App bot, on an OPEN PR into
  // `main`, from a HEAD branch on the monorepo itself (never a fork), carrying exactly ONE commit,
  // may claim this authz path. Fail closed if the adapter could not resolve a bot id.
  if (
    !Number.isInteger(facts.expectedBotId) ||
    facts.expectedBotLogin.length === 0 ||
    facts.prState !== "open" ||
    facts.baseRef !== "main" ||
    facts.prUserLogin !== facts.expectedBotLogin ||
    facts.prUserId !== facts.expectedBotId ||
    facts.prUserType !== "Bot" ||
    facts.headRepoFullName === null ||
    facts.headRepoFullName.toLowerCase() !==
      facts.expectedHeadRepoFullName.toLowerCase() ||
    facts.commitCount !== 1
  ) {
    return { isEnvManagerPr: false };
  }

  // IDENTITY_IS_THE_OPERATOR_BOT (commit side) — parity with classify-env-manager-fast-path.sh:183-189.
  // The signed HEAD commit's own linked GitHub author MUST be that same operator bot: a valid
  // signature from any other verified key (a contributor's GPG key on a look-alike commit) is not enough.
  if (
    facts.commitAuthorLogin !== facts.expectedBotLogin ||
    facts.commitAuthorId !== facts.expectedBotId
  ) {
    return { isEnvManagerPr: false };
  }

  return { isEnvManagerPr: true, targetNodeRef: node };
}
