// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/canonical-fork-sync.server`
 * Purpose: Recognize node-template default-branch pushes while automatic fork source sync is disabled.
 * Scope: Webhook-triggered facade. It performs no GitHub, database, or deploy-plane writes.
 * Invariants:
 *   - AUTOMATIC_FORK_SOURCE_SYNC_DISABLED: a template push never creates or updates a fork branch/PR.
 *   - OBSERVABLE_NO_WRITE: a recognized push emits one structured event so the disabled lane is visible.
 *   - TRIGGER_IS_TEMPLATE_MAIN_PUSH: unrelated repositories and non-default branches remain silent.
 * Side-effects: structured log only.
 * Links: src/app/api/internal/webhooks/[source]/route.ts, docs/spec/repo-sync-contract.md,
 *   bug.5304
 * @public
 */

import type { Logger } from "pino";
import type { ServerEnv } from "@/shared/env";

const TEMPLATE_REPO = "node-template";

export interface TemplateMainPush {
  readonly sourceOwner: string;
  readonly sourceRepo: string;
  readonly defaultBranch: string;
  readonly afterSha: string;
}

/** Narrow a GitHub push payload to a node-template default-branch push, or null. */
export function extractTemplateMainPush(
  payload: Record<string, unknown>,
  templateOwner: string
): TemplateMainPush | null {
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!repo) return null;
  const owner = (repo.owner as Record<string, unknown> | undefined)?.login;
  const name = repo.name;
  const defaultBranch = repo.default_branch;
  const ref = payload.ref;
  const afterSha = payload.after;
  if (
    typeof owner !== "string" ||
    typeof name !== "string" ||
    typeof defaultBranch !== "string" ||
    typeof ref !== "string" ||
    typeof afterSha !== "string"
  ) {
    return null;
  }
  if (owner !== templateOwner || name !== TEMPLATE_REPO) return null;
  if (ref !== `refs/heads/${defaultBranch}`) return null;
  return { sourceOwner: owner, sourceRepo: name, defaultBranch, afterSha };
}

/**
 * Deliberate fail-closed terminal for the retired automatic source-sync lane.
 *
 * Keep this recognition seam until the webhook caller and dormant deploy-plane methods are removed in
 * the package/codemod migration. It proves a production template push was observed without retaining a
 * hidden switch that could reactivate fleet writes.
 */
export function dispatchCanonicalForkSync(
  payload: Record<string, unknown>,
  env: ServerEnv,
  log: Logger
): void {
  if (!env.NODE_TEMPLATE_OWNER) return;
  const ctx = extractTemplateMainPush(payload, env.NODE_TEMPLATE_OWNER);
  if (!ctx) return;

  const event = "node_template_fork_sync_disabled";
  log.warn(
    {
      event,
      source: `${ctx.sourceOwner}/${ctx.sourceRepo}@${ctx.afterSha.slice(0, 8)}`,
      reason: "automatic fork source sync is retired after bug.5304",
    },
    event
  );
}
