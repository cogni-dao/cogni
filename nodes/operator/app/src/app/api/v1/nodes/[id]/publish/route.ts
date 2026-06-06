// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/publish`
 * Purpose: Build the governance-only repo-spec YAML and open a PR against the target repo via the GitHub App.
 * Scope: Owner-gated. Advances dao_formed → published when the PR is opened. Idempotent: re-opening
 *   yields the existing PR.
 * Invariants: GH_APP_INSTALL_REQUIRED, NODE_SOVEREIGNTY (PR only; never force-push), STATE_MACHINE_TOTAL.
 * Side-effects: IO (GitHub REST API, Postgres)
 * Links: src/adapters/server/vcs/github-repo-write.ts, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";

import { createDoltHubDatabaseEnsurer } from "@/bootstrap/capabilities/dolthub-database";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { resolveAppDb } from "@/bootstrap/container";
import { withRootSpan } from "@/bootstrap/otel";
import { transition } from "@/features/nodes/state-machine";
import { getServerSessionUser } from "@/lib/auth/server";
import { type NodeStatus, nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import { buildNodeKnowledgeRemote } from "@/shared/node-app-scaffold/knowledge-remote";
import {
  createRequestContext,
  EVENT_NAMES,
  logEvent,
  logRequestEnd,
  logRequestStart,
  makeLogger,
} from "@/shared/observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const baseLog = makeLogger();
const clock = { now: () => new Date().toISOString() };

/**
 * Classify a node-repo-write mint failure into a stable, low-cardinality code.
 * Maps the GitHub adapter's thrown errors onto the failure classes an operator
 * must distinguish.
 */
type MintErrorCode =
  | "app_not_installed"
  | "forbidden"
  | "github_not_found"
  | "template_not_found"
  | "repo_exists"
  | "github_rate_limited"
  | "main_not_ready"
  | "unknown";

function extractHttpStatus(err: unknown): number | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const directStatus = (err as { status?: unknown }).status;
  if (typeof directStatus === "number") {
    return directStatus;
  }
  const responseStatus = (err as { response?: { status?: unknown } }).response
    ?.status;
  if (typeof responseStatus === "number") {
    return responseStatus;
  }
  const message = err instanceof Error ? err.message : "";
  const match = /\bHTTP\s+(\d{3})\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

function classifyMintError(err: unknown): {
  errorCode: MintErrorCode;
  status: number | undefined;
} {
  const status = extractHttpStatus(err);
  const message = err instanceof Error ? err.message : "";
  if (/not installed/i.test(message)) {
    return { errorCode: "app_not_installed", status };
  }
  if (/main not ready/i.test(message)) {
    return { errorCode: "main_not_ready", status };
  }
  if (status === 422 || /already exists|name already/i.test(message)) {
    return { errorCode: "repo_exists", status };
  }
  if (status === 429 || (status === 403 && /rate limit/i.test(message))) {
    return { errorCode: "github_rate_limited", status };
  }
  if (
    status === 403 ||
    /administration|not accessible|forbidden/i.test(message)
  ) {
    return { errorCode: "forbidden", status };
  }
  if (/node-template.*not found|node-template.*was not found/i.test(message)) {
    return { errorCode: "template_not_found", status };
  }
  if (status === 404) {
    if (/node-template/i.test(message)) {
      return { errorCode: "template_not_found", status };
    }
    return { errorCode: "github_not_found", status };
  }
  if (/not found/i.test(message)) {
    return { errorCode: "github_not_found", status };
  }
  return { errorCode: "unknown", status };
}

const mintErrorMessages: Record<MintErrorCode, string> = {
  app_not_installed:
    "GitHub App installation is missing on the target repository.",
  forbidden: "GitHub App cannot write to the target repository.",
  github_not_found: "Target GitHub repository was not found.",
  template_not_found: "Configured node-template repository was not found.",
  repo_exists:
    "Target node repository already exists and could not be reused safely.",
  github_rate_limited: "GitHub rate limit blocked node repo publishing.",
  main_not_ready: "Minted node repository main branch was not ready.",
  unknown: "GitHub repo publishing failed.",
};

function statusForMintError(errorCode: MintErrorCode): number {
  switch (errorCode) {
    case "repo_exists":
      return 409;
    case "github_rate_limited":
      return 429;
    default:
      return 424;
  }
}

type PublishStep =
  | "auth"
  | "config"
  | "load_node"
  | "validate_state"
  | "validate_addresses"
  | "bootstrap_dolthub"
  | "fork_from_template"
  | "open_submodule_pr"
  | "update_node";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: Request, routeArgs: RouteParams) {
  return withRootSpan(
    "POST nodes.publish",
    { route_id: "nodes.publish" },
    async ({ traceId }) => {
      const startTime = performance.now();
      const ctx = createRequestContext({ baseLog, clock }, request, {
        routeId: "nodes.publish",
        traceId,
        session: undefined,
      });
      const { id } = await routeArgs.params;
      let currentStep: PublishStep = "auth";

      const durationMs = () => Math.round(performance.now() - startTime);
      const logTerminal = (
        level: "info" | "warn" | "error",
        fields: Record<string, unknown>
      ): void => {
        ctx.log[level](
          {
            event: EVENT_NAMES.NODE_PUBLISH_COMPLETE,
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            nodeId: id,
            step: currentStep,
            durationMs: durationMs(),
            ...fields,
          },
          EVENT_NAMES.NODE_PUBLISH_COMPLETE
        );
      };
      const logStep = (
        step: PublishStep,
        outcome: "started" | "success" | "error",
        fields: Record<string, unknown> = {}
      ): void => {
        ctx.log.info(
          {
            event: EVENT_NAMES.NODE_PUBLISH_COMPLETE,
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            nodeId: id,
            phase: "step",
            step,
            outcome,
            durationMs: durationMs(),
            ...fields,
          },
          EVENT_NAMES.NODE_PUBLISH_COMPLETE
        );
      };

      logRequestStart(ctx.log);

      try {
        const session = await getServerSessionUser();
        if (!session) {
          logTerminal("warn", {
            outcome: "error",
            errorCode: "unauthorized",
            status: 401,
          });
          logRequestEnd(ctx.log, { status: 401, durationMs: durationMs() });
          return NextResponse.json({ error: "unauthorized" }, { status: 401 });
        }

        ctx.log.info(
          {
            event: EVENT_NAMES.NODE_PUBLISH_COMPLETE,
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            nodeId: id,
            phase: "started",
          },
          EVENT_NAMES.NODE_PUBLISH_COMPLETE
        );

        currentStep = "config";
        const env = serverEnv();
        if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
          logTerminal("error", {
            outcome: "error",
            errorCode: "repo_write_config_missing",
            status: 503,
          });
          logRequestEnd(ctx.log, { status: 503, durationMs: durationMs() });
          return NextResponse.json(
            {
              error: "operator not configured for repo write",
              reason:
                "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
            },
            { status: 503 }
          );
        }
        // Mint owner + template home are env-scoped and FAIL CLOSED — never derived from the operator's
        // own monorepo org. A test/candidate operator must have zero access to Cogni-DAO; deriving the
        // mint target from repoOwner would let it mint into the real org. So both are required explicitly.
        const mintOwner = env.NODE_MINT_OWNER;
        const templateOwner = env.NODE_TEMPLATE_OWNER;
        if (!mintOwner || !templateOwner) {
          logTerminal("error", {
            outcome: "error",
            errorCode: "node_mint_config_missing",
            status: 503,
          });
          logRequestEnd(ctx.log, { status: 503, durationMs: durationMs() });
          return NextResponse.json(
            {
              error: "operator not configured for node minting",
              reason:
                "NODE_MINT_OWNER + NODE_TEMPLATE_OWNER required (env-scoped; must not derive from the operator's own monorepo org)",
            },
            { status: 503 }
          );
        }
        if (!env.DOLTHUB_API_TOKEN || !env.DOLTHUB_OWNER) {
          logTerminal("error", {
            outcome: "error",
            errorCode: "dolthub_config_missing",
            status: 503,
          });
          logRequestEnd(ctx.log, { status: 503, durationMs: durationMs() });
          return NextResponse.json(
            {
              error: "operator not configured for DoltHub bootstrap",
              reason:
                "DOLTHUB_API_TOKEN + DOLTHUB_OWNER required to create environment-scoped node knowledge repos",
            },
            { status: 503 }
          );
        }

        currentStep = "load_node";
        const db = resolveAppDb();
        logStep("load_node", "started");
        const existing = await withTenantScope(
          db,
          userActor(session.id as UserId),
          async (tx) =>
            tx
              .select()
              .from(nodes)
              .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
              .limit(1)
        );
        const node = existing[0];
        if (!node) {
          logStep("load_node", "error", { errorCode: "node_not_found" });
          logTerminal("warn", {
            outcome: "error",
            errorCode: "node_not_found",
            status: 404,
          });
          logRequestEnd(ctx.log, { status: 404, durationMs: durationMs() });
          return NextResponse.json({ error: "not found" }, { status: 404 });
        }
        logStep("load_node", "success", {
          slug: node.slug,
          nodeStatus: node.status,
        });

        // Idempotent: if already published, return the existing PR.
        if (
          ["published", "wallet_ready", "payments_ready", "active"].includes(
            node.status
          ) &&
          node.publishPrUrl
        ) {
          logTerminal("info", {
            outcome: "already_published",
            status: 200,
            slug: node.slug,
            nodeStatus: node.status,
          });
          logRequestEnd(ctx.log, { status: 200, durationMs: durationMs() });
          return NextResponse.json({ node, alreadyPublished: true });
        }

        currentStep = "validate_state";
        const t = transition(node.status as NodeStatus, {
          type: "spec_published",
        });
        if (!t.ok) {
          logTerminal("warn", {
            outcome: "error",
            errorCode: "invalid_state",
            status: 409,
            slug: node.slug,
            nodeStatus: node.status,
          });
          logRequestEnd(ctx.log, { status: 409, durationMs: durationMs() });
          return NextResponse.json(
            {
              error: "invalid state for publish",
              reason: t.reason,
              currentStatus: node.status,
            },
            { status: 409 }
          );
        }

        currentStep = "validate_addresses";
        if (
          !node.chainId ||
          !node.daoAddress ||
          !node.pluginAddress ||
          !node.signalAddress
        ) {
          logTerminal("warn", {
            outcome: "error",
            errorCode: "node_addresses_missing",
            status: 409,
            slug: node.slug,
            nodeStatus: node.status,
            hasChainId: Boolean(node.chainId),
            hasDaoAddress: Boolean(node.daoAddress),
            hasPluginAddress: Boolean(node.pluginAddress),
            hasSignalAddress: Boolean(node.signalAddress),
          });
          logRequestEnd(ctx.log, { status: 409, durationMs: durationMs() });
          return NextResponse.json(
            {
              error:
                "node row missing required addresses for repo-spec emission",
            },
            { status: 409 }
          );
        }

        const knowledgeRemote = buildNodeKnowledgeRemote(
          node.slug,
          env.DOLTHUB_OWNER
        );
        let doltHub: { owner: string; repo: string; created: boolean };
        try {
          currentStep = "bootstrap_dolthub";
          logStep("bootstrap_dolthub", "started", {
            slug: node.slug,
            owner: knowledgeRemote.owner,
            repo: knowledgeRemote.repo,
          });
          doltHub = await createDoltHubDatabaseEnsurer(env).ensureDatabase({
            owner: knowledgeRemote.owner,
            repo: knowledgeRemote.repo,
            description: `Cogni node ${node.slug} knowledge mirror`,
          });
          logStep("bootstrap_dolthub", "success", {
            slug: node.slug,
            owner: doltHub.owner,
            repo: doltHub.repo,
            created: doltHub.created,
          });
        } catch (err) {
          logStep("bootstrap_dolthub", "error", {
            slug: node.slug,
            owner: knowledgeRemote.owner,
            repo: knowledgeRemote.repo,
            errorCode: "dolthub_bootstrap_failed",
          });
          logTerminal("error", {
            outcome: "error",
            errorCode: "dolthub_bootstrap_failed",
            status: 502,
            slug: node.slug,
            nodeStatus: node.status,
          });
          logRequestEnd(ctx.log, { status: 502, durationMs: durationMs() });
          const message = err instanceof Error ? err.message : "unknown";
          return NextResponse.json(
            { error: "dolthub bootstrap failed", reason: message },
            { status: 502 }
          );
        }

        // Submodule birth: mint the node's own repo as a named fork of node-template (its ~1100 files
        // live there, not inlined into the operator), then the operator authors a PR pinning it as a git
        // submodule at `nodes/<slug>` + the footprint gens — one App-authored commit, PR URL synchronous.
        const writer = createNodeRepoWriter(env);
        const identity = {
          nodeId: node.id,
          chainId: node.chainId,
          daoContract: node.daoAddress,
          pluginContract: node.pluginAddress,
          signalContract: node.signalAddress,
          knowledgeRemote,
        };
        let pr: { prNumber: number; prUrl: string };
        try {
          currentStep = "fork_from_template";
          logStep("fork_from_template", "started", {
            slug: node.slug,
            owner: mintOwner,
            templateOwner,
          });
          const minted = await writer.forkFromTemplate({
            templateOwner,
            owner: mintOwner,
            slug: node.slug,
            ...identity,
          });
          logStep("fork_from_template", "success", {
            slug: node.slug,
            owner: mintOwner,
            headSha: minted.headSha,
          });
          currentStep = "open_submodule_pr";
          // Submodule-PR target = the operator's deployment monorepo (nodes live at nodes/<slug> there).
          // Wizard-scoped, fail-open override: defaults to node.repoOwner/repoName (= getGithubRepo() =
          // Cogni-DAO/cogni in prod, unchanged). candidate-a points it at a cogni-shaped mirror in the
          // throwaway org so the test app can open the pin-PR without any Cogni-DAO access. Does NOT
          // touch getGithubRepo()/operator identity.
          const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER ?? node.repoOwner;
          const parentRepo = env.NODE_SUBMODULE_PARENT_REPO ?? node.repoName;
          logStep("open_submodule_pr", "started", {
            slug: node.slug,
            owner: parentOwner,
            repo: parentRepo,
            nodeRepoHeadSha: minted.headSha,
          });
          pr = await writer.openNodeSubmodulePr({
            owner: parentOwner,
            repo: parentRepo,
            slug: node.slug,
            ...identity,
            nodeRepoUrl: minted.cloneUrl,
            nodeRepoHeadSha: minted.headSha,
          });
          logStep("open_submodule_pr", "success", {
            slug: node.slug,
            owner: parentOwner,
            repo: parentRepo,
            prNumber: pr.prNumber,
            prUrl: pr.prUrl,
          });
        } catch (err) {
          const { errorCode, status } = classifyMintError(err);
          const responseStatus = statusForMintError(errorCode);
          logStep(currentStep, "error", {
            slug: node.slug,
            errorCode,
            githubStatus: status,
          });
          ctx.log.error(
            {
              event: EVENT_NAMES.ADAPTER_GITHUB_REPO_WRITE_ERROR,
              reqId: ctx.reqId,
              routeId: ctx.routeId,
              nodeId: id,
              dep: "github",
              step: currentStep,
              reasonCode: errorCode,
              githubStatus: status,
              durationMs: durationMs(),
            },
            EVENT_NAMES.ADAPTER_GITHUB_REPO_WRITE_ERROR
          );
          logTerminal("error", {
            outcome: "error",
            errorCode,
            githubStatus: status,
            status: responseStatus,
            slug: node.slug,
            nodeStatus: node.status,
          });
          logRequestEnd(ctx.log, {
            status: responseStatus,
            durationMs: durationMs(),
          });
          return NextResponse.json(
            {
              error: "node publish dependency failed",
              reason: mintErrorMessages[errorCode],
              errorCode,
              step: currentStep,
              reqId: ctx.reqId,
              routeId: ctx.routeId,
              nodeId: id,
              githubStatus: status,
            },
            { status: responseStatus }
          );
        }

        currentStep = "update_node";
        logStep("update_node", "started", { slug: node.slug });
        const [updated] = await withTenantScope(
          db,
          userActor(session.id as UserId),
          async (tx) =>
            tx
              .update(nodes)
              .set({
                status: t.nextStatus,
                publishPrUrl: pr.prUrl,
                updatedAt: new Date(),
              })
              .where(and(eq(nodes.id, id), eq(nodes.ownerUserId, session.id)))
              .returning()
        );
        logStep("update_node", "success", {
          slug: node.slug,
          nextStatus: t.nextStatus,
        });

        logEvent(ctx.log, EVENT_NAMES.NODE_PUBLISH_COMPLETE, {
          reqId: ctx.reqId,
          routeId: ctx.routeId,
          nodeId: id,
          outcome: "success",
          slug: node.slug,
          nodeStatus: node.status,
          nextStatus: t.nextStatus,
          prNumber: pr.prNumber,
          prUrl: pr.prUrl,
          dolthubOwner: doltHub.owner,
          dolthubRepo: doltHub.repo,
          dolthubCreated: doltHub.created,
          durationMs: durationMs(),
        });
        logRequestEnd(ctx.log, { status: 200, durationMs: durationMs() });
        return NextResponse.json({ node: updated, pr, doltHub });
      } catch (_err) {
        logTerminal("error", {
          outcome: "error",
          errorCode: "unhandled",
          status: 500,
        });
        logRequestEnd(ctx.log, { status: 500, durationMs: durationMs() });
        return NextResponse.json(
          {
            error: "node publish failed",
            reason: "Unexpected node publish failure.",
            errorCode: "unhandled",
            step: currentStep,
            reqId: ctx.reqId,
            routeId: ctx.routeId,
            nodeId: id,
          },
          { status: 500 }
        );
      }
    }
  );
}
