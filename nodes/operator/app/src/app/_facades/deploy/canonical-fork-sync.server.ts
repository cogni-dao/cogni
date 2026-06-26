// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/canonical-fork-sync.server`
 * Purpose: node-template merge→main → fork sync. On a push to node-template's default branch, push
 *   THREE tiers to every active child fork: (1) surgical overwrite of the CI/contract files AND the
 *   node-template-authoritative IDENTITY SUBSTRATE (repo-spec parser + agent.json/header/og projection),
 *   required + always applies (never blocked by an app merge conflict); (2) an upstream-merge PR carrying
 *   the remaining foundational substrate (app/graphs/runtime/packages),
 *   with Tier 3 carved OUT so it is conflict-free + always auto-mergeable; (3) node identity/presentation
 *   (homepage, branding, repo-spec, persona) — NEVER synced, node-template is a starter only.
 * Scope: Webhook-triggered facade (sibling of dispatchNodePreviewPromote). Resolves spawned-node forks from
 *   the `nodes` table; delegates per-fork writes to the operator deploy plane. No new trigger, no token —
 *   the operator GitHub App webhook (HMAC-verified upstream) is the trigger.
 * Invariants:
 *   - TRIGGER_IS_TEMPLATE_MAIN_PUSH: fires only on `push` to `NODE_TEMPLATE_OWNER/node-template`'s default branch.
 *   - TARGETS_FROM_PARENT_CATALOG: targets = `source_repo` rows in the parent monorepo's `infra/catalog`
 *     (`NODE_SUBMODULE_PARENT_{OWNER,REPO}`), read via the App. Env-aligned (cogni-test-org/cogni-monorepo
 *     on candidate-a → cogni-test-org forks the App can write; Cogni-DAO/cogni on prod → Cogni-DAO forks).
 *     node-template (source) + operator (hub) excluded. NOT the `nodes` table (wizard-spawn state, may not
 *     hold catalog-declared forks) and NOT the node registry (its repo is the parent monorepo / hardcoded).
 *   - TIERS_DECOUPLED (node-ci-cd-contract): Tier 1 surgically overwrites the flight-contract files so a
 *     CI fix lands cleanly even when Tier 2's substrate merge conflicts; Tier 2 preserves fork
 *     customizations (`FORK_FREEDOM`, `POLICY_STAYS_LOCAL`) via the shared merge-base. Per-tier,
 *     per-fork error isolation.
 *   - TIER3_NEVER_SYNCED (repo-sync-contract): node identity/presentation (`node_local` globs declared in
 *     node-template's sync-manifest) is restored to the fork's own version inside Tier 2's merge — never
 *     overwritten. Carving it OUT is exactly what makes Tier 1 + Tier 2 always auto-mergeable.
 * Side-effects: IO (DB read via service db, GitHub Git Data API writes via the deploy plane). Fire-and-forget.
 * Links: src/ports/operator-deploy-plane.port.ts, src/adapters/server/vcs/github-repo-write.ts,
 *   src/app/api/internal/webhooks/[source]/route.ts, docs/spec/node-ci-cd-contract.md, docs/spec/repo-sync-contract.md
 * @public
 */

import type { Logger } from "pino";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import type { OperatorDeployPlanePort } from "@/ports";
import type { ServerEnv } from "@/shared/env";

const TEMPLATE_REPO = "node-template";

/**
 * Tier 1 — the required, byte-for-byte-safe CI/contract set. A fork drifting here breaks the operator's
 * flight contract (`node-ci-cd-contract` §Forward path: the fork must publish `image_repository:sha-<sha>`
 * via its build→GHCR workflow + pass its merge gate). Surgically overwritten so the fix always lands —
 * never blocked by app-level merge conflicts. Tier 2 (app/graphs/runtime) is a separate upstream-merge PR.
 */
export const CI_CONTRACT_PATHS = [
  ".github/workflows/ci.yaml",
  ".github/workflows/pr-build.yml",
  ".github/workflows/pr-lint.yaml",
  "scripts/check-node-ci-workflow.mjs",
] as const;

/**
 * Tier 1b — the node-template-authoritative IDENTITY SUBSTRATE: the repo-spec parser + the projection
 * that turns a node's `intent.brand.{icon,color}` into its `/.well-known/agent.json` (which the operator
 * gallery reads) and its own header/og mark. This code is identical across every node (it carries NO
 * node-specific content — a node customizes via its Tier-3 `repo-spec.yaml`, never this), so it ships in
 * the SURGICAL overwrite set, not the fragile Tier-2 app merge. Without this, a fork can set `brand.icon`
 * but never PROJECT it → the gallery shows a monogram forever. CI-gated like the rest of Tier 1.
 */
export const IDENTITY_SUBSTRATE_PATHS = [
  "packages/repo-spec/src/schema.ts",
  "packages/repo-spec/src/accessors.ts",
  "packages/repo-spec/src/index.ts",
  "app/src/shared/config/repoSpec.server.ts",
  "app/src/shared/brand/brandIcons.tsx",
  "app/src/app/.well-known/agent.json/route.ts",
  "app/src/app/opengraph-image.tsx",
  "app/src/features/layout/components/AppHeader.tsx",
  "app/src/app/(public)/layout.tsx",
] as const;

export interface TemplateMainPush {
  readonly sourceOwner: string;
  readonly sourceRepo: string;
  /** Default branch name (e.g. `main`) — the Tier-2 upstream merge head. */
  readonly defaultBranch: string;
  /** The pushed commit SHA on the default branch — the Tier-1 canonical content version. */
  readonly afterSha: string;
}

export interface ForkSyncTarget {
  readonly owner: string;
  readonly name: string;
  readonly slug: string;
}

export interface ForkSyncLedgerEntry {
  readonly target: string;
  /** Tier 1 — CI/contract overwrite. */
  readonly ci: "pr_opened" | "no_changes" | "failed";
  readonly ciPrUrl?: string;
  /** Tier 2 — optional upstream app/graphs merge PR. */
  readonly template: "pr_opened" | "up_to_date" | "failed";
  readonly templatePrUrl?: string;
}

/**
 * Narrow a GitHub `push` webhook payload to a node-template default-branch push, or null.
 * Identity is env-driven (`NODE_TEMPLATE_OWNER`) so it works on candidate-a (cogni-test-org) and prod.
 */
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
 * All tiers per fork, error-isolated. Injected `deployPlane` keeps this unit-testable with no GitHub/DB.
 * `nodeLocalPaths` (Tier 3 — node identity/presentation, resolved once from node-template's manifest)
 * is threaded into every fork's Tier-2 merge so the upstream PR carries substrate only.
 */
export async function fanOutForkSync(
  deployPlane: OperatorDeployPlanePort,
  ctx: TemplateMainPush,
  targets: readonly ForkSyncTarget[],
  nodeLocalPaths: readonly string[]
): Promise<readonly ForkSyncLedgerEntry[]> {
  const out: ForkSyncLedgerEntry[] = [];
  for (const t of targets) {
    const target = `${t.owner}/${t.name}`;

    // Tier 1 — surgical CI/contract overwrite (required).
    let ci: ForkSyncLedgerEntry["ci"] = "failed";
    let ciPrUrl: string | undefined;
    try {
      const r = await deployPlane.syncCanonicalFilesToFork({
        sourceOwner: ctx.sourceOwner,
        sourceRepo: ctx.sourceRepo,
        sourceRef: ctx.afterSha,
        targetOwner: t.owner,
        targetRepo: t.name,
        slug: t.slug,
        canonicalPaths: [...CI_CONTRACT_PATHS, ...IDENTITY_SUBSTRATE_PATHS],
      });
      ci = r.status;
      if (r.status === "pr_opened") ciPrUrl = r.prUrl;
    } catch {
      ci = "failed";
    }

    // Tier 2 — optional upstream app/graphs merge PR (independent of Tier 1's outcome).
    let template: ForkSyncLedgerEntry["template"] = "failed";
    let templatePrUrl: string | undefined;
    try {
      const r = await deployPlane.syncTemplateUpstreamToFork({
        templateOwner: ctx.sourceOwner,
        templateRepo: ctx.sourceRepo,
        templateSha: ctx.afterSha,
        forkOwner: t.owner,
        forkRepo: t.name,
        forkBranch: "main",
        nodeLocalPaths,
      });
      template = r.status;
      if (r.status === "pr_opened") templatePrUrl = r.prUrl;
    } catch {
      template = "failed";
    }

    out.push({
      target,
      ci,
      ...(ciPrUrl ? { ciPrUrl } : {}),
      template,
      ...(templatePrUrl ? { templatePrUrl } : {}),
    });
  }
  return out;
}

/**
 * Dispatch a fork sync from a GitHub `push` webhook payload.
 * Fire-and-forget: errors are logged, never thrown (the webhook 200s regardless).
 */
export function dispatchCanonicalForkSync(
  payload: Record<string, unknown>,
  env: ServerEnv,
  log: Logger
): void {
  if (!env.NODE_TEMPLATE_OWNER) return;
  const ctx = extractTemplateMainPush(payload, env.NODE_TEMPLATE_OWNER);
  if (!ctx) return;

  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    log.debug(
      "canonical fork sync skipped — GH_REVIEW_APP_ID/PRIVATE_KEY not configured"
    );
    return;
  }
  if (!env.NODE_SUBMODULE_PARENT_OWNER || !env.NODE_SUBMODULE_PARENT_REPO) {
    log.debug(
      "canonical fork sync skipped — NODE_SUBMODULE_PARENT_{OWNER,REPO} not configured"
    );
    return;
  }

  void syncToAllForks(
    ctx,
    env.NODE_SUBMODULE_PARENT_OWNER,
    env.NODE_SUBMODULE_PARENT_REPO,
    env,
    log
  );
}

async function syncToAllForks(
  ctx: TemplateMainPush,
  parentOwner: string,
  parentRepo: string,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  const event = "node_template_fork_sync_complete";
  try {
    const plane = createOperatorDeployPlane(env);
    const targets = await plane.listCatalogForkTargets({
      parentOwner,
      parentRepo,
    });

    // Tier-3 globs are DATA: resolved once from node-template's own sync-manifest at the pushed SHA,
    // then carved out of every fork's Tier-2 merge (TIER3_IS_DATA, spec.repo-sync-contract).
    const nodeLocalPaths = await plane.resolveNodeLocalPaths({
      sourceOwner: ctx.sourceOwner,
      sourceRepo: ctx.sourceRepo,
      sourceRef: ctx.afterSha,
    });

    const entries = await fanOutForkSync(plane, ctx, targets, nodeLocalPaths);

    log.info(
      {
        event,
        source: `${ctx.sourceOwner}/${ctx.sourceRepo}@${ctx.afterSha.slice(0, 8)}`,
        forks: targets.length,
        ciOpened: entries.filter((e) => e.ci === "pr_opened").length,
        ciFailed: entries.filter((e) => e.ci === "failed").length,
        templateOpened: entries.filter((e) => e.template === "pr_opened")
          .length,
        templateFailed: entries.filter((e) => e.template === "failed").length,
        entries,
      },
      event
    );
  } catch (error) {
    log.error(
      {
        event,
        source: `${ctx.sourceOwner}/${ctx.sourceRepo}@${ctx.afterSha.slice(0, 8)}`,
        error: String(error),
      },
      "canonical fork sync failed"
    );
  }
}
