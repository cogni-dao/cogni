// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/governance/actions`
 * Purpose: GitHub action handlers for on-chain governance signals (merge PR, grant/revoke collaborator).
 * Scope: Pure action execution — receives Octokit + signal context, returns ActionResult. Does not import adapters.
 * Invariants: Each handler validates input before API call. Action key = `${action}:${target}`.
 * Side-effects: IO (GitHub API calls via injected Octokit)
 * Links: docs/spec/governance-signal-execution.md
 * @public
 */

import type { Octokit } from "@octokit/core";
import type { Logger } from "pino";

import type { ActionResult, RepoRef, Signal } from "./signal-types";

// ---------------------------------------------------------------------------
// Action handler type
// ---------------------------------------------------------------------------

export type ActionHandler = (
  signal: Signal,
  repoRef: RepoRef,
  octokit: Octokit,
  log: Logger
) => Promise<ActionResult>;

// ---------------------------------------------------------------------------
// merge:change — merge a pull request
// ---------------------------------------------------------------------------

export async function mergeChange(
  signal: Signal,
  repoRef: RepoRef,
  octokit: Octokit,
  log: Logger
): Promise<ActionResult> {
  const pr = Number(signal.resource);
  if (!Number.isInteger(pr) || pr <= 0) {
    return {
      success: false,
      action: "validation_failed",
      error: "resource must be a positive integer (PR number)",
    };
  }

  // Parse merge params from signal
  let mergeMethod: "merge" | "squash" | "rebase" = "merge";
  if (signal.paramsJson) {
    try {
      const params = JSON.parse(signal.paramsJson) as Record<string, unknown>;
      if (params.mergeMethod === "squash" || params.mergeMethod === "rebase") {
        mergeMethod = params.mergeMethod;
      }
    } catch {
      // Use default merge method
    }
  }

  log.info(
    { owner: repoRef.owner, repo: repoRef.repo, pr, mergeMethod },
    "merging PR via governance signal"
  );

  try {
    const response = await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner: repoRef.owner,
        repo: repoRef.repo,
        pull_number: pr,
        merge_method: mergeMethod,
      }
    );

    return {
      success: true,
      action: "merge_completed",
      sha: (response.data as Record<string, unknown>).sha as string,
      repoUrl: signal.repoUrl,
      changeNumber: pr,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ error: msg, pr }, "failed to merge PR");
    return {
      success: false,
      action: "merge_failed",
      error: msg,
      repoUrl: signal.repoUrl,
      changeNumber: pr,
    };
  }
}

// ---------------------------------------------------------------------------
// grant:collaborator — add repository collaborator
// ---------------------------------------------------------------------------

const GITHUB_USERNAME_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

export async function grantCollaborator(
  signal: Signal,
  repoRef: RepoRef,
  octokit: Octokit,
  log: Logger
): Promise<ActionResult> {
  const username = signal.resource;

  if (!username || !GITHUB_USERNAME_RE.test(username)) {
    return {
      success: false,
      action: "validation_failed",
      error: `Invalid GitHub username: ${username}`,
    };
  }

  // Parse permission from signal
  let permission: "admin" | "maintain" | "push" = "push";
  if (signal.paramsJson) {
    try {
      const params = JSON.parse(signal.paramsJson) as Record<string, unknown>;
      if (params.permission === "maintain" || params.permission === "push") {
        permission = params.permission;
      }
    } catch {
      // Use default permission
    }
  }

  log.info(
    { owner: repoRef.owner, repo: repoRef.repo, username, permission },
    "granting collaborator via governance signal"
  );

  try {
    await octokit.request(
      "PUT /repos/{owner}/{repo}/collaborators/{username}",
      {
        owner: repoRef.owner,
        repo: repoRef.repo,
        username,
        permission,
      }
    );

    return {
      success: true,
      action: "collaborator_granted",
      username,
      repoUrl: signal.repoUrl,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ error: msg, username }, "failed to grant collaborator");
    return {
      success: false,
      action: "collaborator_grant_failed",
      error: msg,
      username,
      repoUrl: signal.repoUrl,
    };
  }
}

// ---------------------------------------------------------------------------
// revoke:collaborator — remove repository collaborator + cancel invitations
// ---------------------------------------------------------------------------

export async function revokeCollaborator(
  signal: Signal,
  repoRef: RepoRef,
  octokit: Octokit,
  log: Logger
): Promise<ActionResult> {
  const username = signal.resource;

  if (!username || !GITHUB_USERNAME_RE.test(username)) {
    return {
      success: false,
      action: "validation_failed",
      error: `Invalid GitHub username: ${username}`,
    };
  }

  log.info(
    { owner: repoRef.owner, repo: repoRef.repo, username },
    "revoking collaborator via governance signal"
  );

  try {
    // Remove existing collaborator
    await octokit.request(
      "DELETE /repos/{owner}/{repo}/collaborators/{username}",
      {
        owner: repoRef.owner,
        repo: repoRef.repo,
        username,
      }
    );

    // Cancel any pending invitations
    try {
      const invitations = await octokit.request(
        "GET /repos/{owner}/{repo}/invitations",
        { owner: repoRef.owner, repo: repoRef.repo }
      );

      const invitationData = invitations.data as Array<{
        id: number;
        invitee: { login: string } | null;
      }>;

      for (const inv of invitationData) {
        if (inv.invitee?.login === username) {
          await octokit.request(
            "DELETE /repos/{owner}/{repo}/invitations/{invitation_id}",
            {
              owner: repoRef.owner,
              repo: repoRef.repo,
              invitation_id: inv.id,
            }
          );
        }
      }
    } catch {
      // Best effort — invitation cleanup is secondary
    }

    return {
      success: true,
      action: "collaborator_revoked",
      username,
      repoUrl: signal.repoUrl,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log.error({ error: msg, username }, "failed to revoke collaborator");
    return {
      success: false,
      action: "collaborator_revoke_failed",
      error: msg,
      username,
      repoUrl: signal.repoUrl,
    };
  }
}

// ---------------------------------------------------------------------------
// Action registry — maps action:target keys to handlers
// ---------------------------------------------------------------------------

const ACTION_REGISTRY: Record<string, ActionHandler> = {
  "merge:change": mergeChange,
  "grant:collaborator": grantCollaborator,
  "revoke:collaborator": revokeCollaborator,
};

/**
 * Resolve an action handler by signal action:target key.
 * Returns undefined if no handler exists for the given action:target combination.
 */
export function resolveAction(
  action: string,
  target: string
): ActionHandler | undefined {
  return ACTION_REGISTRY[`${action}:${target}`];
}
