// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/envs`
 * Purpose: Node env-membership verb (story.5020 W4) — add OR remove ONE environment from a node's
 *   deploy reach by opening an operator-authored PR that edits the OPERATOR monorepo catalog
 *   (`infra/catalog/<slug>.yaml` `envs:` line + `deployment_provider` / `compute_api: node-deploy`
 *   cells + scheduler routing; story.5137 / task.5411 — no AppSet, overlay or ExternalSecret).
 *   Individual memberships are independently editable, but
 *   the final environment and current `activity_env` cannot be removed. Full decommission and
 *   authority transfer are separate flows.
 *   PLUS the placement lever (story.5016 T5): `{env, placement: "k3s"|"akash"}` picks the serving lane
 *   for an env ALREADY in reach — akash upserts `deployment_provider.<env>` plus the env's scheduler
 *   routing; k3s is refused for an externally built node (K3S_NODE_LANE_RETIRED, task.5411). `present` and
 *   `placement` are MUTUALLY EXCLUSIVE (exactly one per request); deploy-straight-onto-akash is
 *   deliberately out of v1 scope — deploy first, then place.
 * Scope: Session auth + a single MANAGE_ENVS authz-gate on the resolved node. Resolves the monorepo
 *   owner/repo exactly like `publish` / `activate-payments` (env-scoped, FAIL CLOSED), then delegates the
 *   byte-exact catalog + routing edit to `GitHubRepoWriter.openNodeEnvPr`.
 * Invariants:
 *   - GH_APP_INSTALL_REQUIRED, PR_AGAINST_MAIN (never force-push to monorepo main).
 *   - MANAGE_ENVS_GATED: ANY env change (add OR remove, candidate-a / preview / production alike) requires
 *     `node.manage_envs` (can_manage_envs — env_manager / admin). Managing deploy topology is a distinct,
 *     narrow governance scope, NOT can_flight or can_promote_production. Fail-closed with a distinct code
 *     (503 authz_unavailable / 403 authz_denied).
 *   - IDEMPOTENT: requesting the already-holding state returns `no_changes` (no PR opened).
 *   - CATALOG_IS_SSOT: the env-set edit is a catalog change; deploy reconcilers consume it.
 *   - DEACTIVATE_ENUMERATES_THE_MONEY (story.5039 PR-B): a remove enumerates the env's live paid
 *     leases from the durable ledger BEFORE the PR opens and embeds them (`openLeases` + a `verify`
 *     read-back URL) in the response — the receipts the node-deploy verb is expected to close when
 *     it retires the workload. Enumeration only; the close itself never happens in this route.
 *   - NO_LEASE_GENERATION (task.5411): the node-deploy verb mints a fresh lease per release, so
 *     neither the add nor the region verb derives or writes a `lease_generation` cell.
 *   - OBSERVABLE: wrapped in `wrapRouteHandlerWithLogging` (routeId `nodes.envs`) — every request
 *     emits the standard start/end envelope + metrics (validation finding on #2311: this verb
 *     previously logged nothing).
 * Side-effects: IO (GitHub REST API, Postgres read)
 * Links: src/adapters/server/vcs/github-repo-write.ts (openNodeEnvPr),
 *   src/shared/node-app-scaffold/gens/env-membership-plan.ts,
 *   https://cognidao.org/knowledge/fleet-capacity-design, story.5020, task.5411
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { nodeIdOrSlug } from "@/features/nodes/node-lookup";
import type { AkashTxAllocationRecord } from "@/ports";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";
import {
  envRemovalViolation,
  NODE_DEPLOY_ENVS,
  type NodeFormationEnv,
  PLACEMENT_PROVIDERS,
  type PlacementProvider,
} from "@/shared/node-app-scaffold/gens";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

const VALID_ENVS = new Set<string>(NODE_DEPLOY_ENVS);

/** Bounded ledger reads — one node × one env can only hold a handful of receipts. */
const LEASE_ENUMERATION_LIMIT = 50;

/** Redacted receipt view for the response body — ids/enums only, no cursors. */
function toOpenLease(receipt: AkashTxAllocationRecord): {
  environment: string;
  cogniKey: string;
  state: string;
  externalName: string | null;
} {
  return {
    environment: receipt.environment,
    cogniKey: receipt.cogniKey,
    state: receipt.state,
    externalName: receipt.externalName ?? null,
  };
}

export const POST = wrapRouteHandlerWithLogging<RouteParams>(
  { routeId: "nodes.envs", auth: { mode: "required", getSessionUser } },
  async (ctx, request, sessionUser, routeArgs) => {
    if (!routeArgs) throw new Error("context required for dynamic routes");
    const { id } = await routeArgs.params;

    const env = serverEnv();
    if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
      return NextResponse.json(
        {
          error: "operator not configured for repo write",
          reason:
            "GH_REVIEW_APP_ID + GH_REVIEW_APP_PRIVATE_KEY_BASE64 required",
        },
        { status: 503 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const {
      env: targetEnv,
      present,
      placement,
      countries,
    } = (body ?? {}) as {
      env?: unknown;
      present?: unknown;
      placement?: unknown;
      countries?: unknown;
    };
    if (typeof targetEnv !== "string" || !VALID_ENVS.has(targetEnv)) {
      return NextResponse.json(
        {
          error: "invalid env",
          reason: `env must be one of ${[...VALID_ENVS].join(", ")}`,
        },
        { status: 400 }
      );
    }
    // MUTUALLY_EXCLUSIVE_VERBS: `{env, present}` toggles deploy reach; `{env, placement}` picks the
    // serving lane for an env ALREADY in reach. Exactly one must be given — composing them (deploy
    // straight onto akash) is deliberately out of v1 scope; deploy first, then place.
    const hasPresent = present !== undefined;
    const hasPlacement = placement !== undefined;
    const hasCountries = countries !== undefined;
    if ([hasPresent, hasPlacement, hasCountries].filter(Boolean).length !== 1) {
      return NextResponse.json(
        {
          error: "invalid body",
          reason:
            "provide exactly one of `present` (boolean, deploy reach), `placement` (k3s|akash, serving lane), or `countries` (ISO 3166-1 alpha-2 list, required placement region)",
        },
        { status: 400 }
      );
    }
    if (
      hasCountries &&
      (!Array.isArray(countries) ||
        countries.length === 0 ||
        !countries.every((c) => typeof c === "string" && /^[A-Z]{2}$/.test(c)))
    ) {
      return NextResponse.json(
        {
          error: "invalid countries",
          reason:
            'countries must be a non-empty array of ISO 3166-1 alpha-2 codes (e.g. ["PT","NL"]). Omit the field entirely for unconstrained placement — an empty list would refuse every provider bid.',
        },
        { status: 400 }
      );
    }
    if (hasPresent && typeof present !== "boolean") {
      return NextResponse.json(
        { error: "invalid present", reason: "present must be a boolean" },
        { status: 400 }
      );
    }
    if (
      hasPlacement &&
      !(PLACEMENT_PROVIDERS as readonly unknown[]).includes(placement)
    ) {
      return NextResponse.json(
        {
          error: "invalid placement",
          reason: `placement must be one of ${PLACEMENT_PROVIDERS.join(", ")}`,
        },
        { status: 400 }
      );
    }

    const db = resolveServiceDb();
    const existing = await db
      .select()
      .from(nodes)
      .where(nodeIdOrSlug(id))
      .limit(1);
    const node = existing[0];
    if (!node) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // MANAGE_ENVS_GATED: any env change (add OR remove, ANY env including production) requires
    // env-management authority — a distinct governance scope, not flight/promote. Fail-closed
    // (503 if no authority configured).
    const gate = await resolveNodeAndAuthorize({
      id: node.id,
      userId: sessionUser.id,
      action: "node.manage_envs",
    });
    if (!gate.ok) {
      const payload =
        gate.errorCode === "authz_unavailable"
          ? { error: "authorization not configured", errorCode: gate.errorCode }
          : { error: "not authorized", errorCode: gate.errorCode };
      return NextResponse.json(payload, { status: gate.status });
    }

    if (hasPresent && present === false) {
      const violation = envRemovalViolation({
        currentEnvs: node.deployEnvs as NodeFormationEnv[],
        activityEnv: node.activityEnv as NodeFormationEnv,
        removeEnv: targetEnv as NodeFormationEnv,
      });
      if (violation) {
        const reason =
          violation === "final_environment_required"
            ? "every node must remain deployed in at least one environment; use the decommission lifecycle to remove the node"
            : "the current activity environment cannot be removed; v1 has no safe cross-environment authority cutover";
        return NextResponse.json(
          {
            error: "node env-membership write rejected",
            errorCode: violation,
            reason,
          },
          { status: 422 }
        );
      }
    }

    // The catalog lives in the OPERATOR monorepo (NOT the node's own repo) — resolve owner/repo from the
    // env-scoped deployment parent exactly like publish/openNodeSubmodulePr does (never derived from the
    // operator app repo or persisted node rows; FAIL CLOSED).
    const owner = env.NODE_SUBMODULE_PARENT_OWNER;
    const repo = env.NODE_SUBMODULE_PARENT_REPO;
    if (!owner || !repo) {
      return NextResponse.json(
        {
          error: "operator not configured for catalog write",
          reason:
            "NODE_SUBMODULE_PARENT_OWNER + NODE_SUBMODULE_PARENT_REPO required (env-scoped deployment parent)",
        },
        { status: 503 }
      );
    }

    const writer = createNodeRepoWriter(env);

    // PLACEMENT verb (story.5016 T5): pick the serving lane for an env already in reach.
    if (hasPlacement) {
      let result: Awaited<ReturnType<typeof writer.openNodePlacementPr>>;
      try {
        result = await writer.openNodePlacementPr({
          owner,
          repo,
          slug: node.slug,
          env: targetEnv as NodeFormationEnv,
          placement: placement as PlacementProvider,
        });
      } catch (err) {
        const status = (err as { status?: number })?.status;
        const code = (err as { code?: string })?.code;
        const reason = err instanceof Error ? err.message : "unknown";
        return NextResponse.json(
          { error: "node placement write failed", errorCode: code, reason },
          { status: typeof status === "number" ? status : 502 }
        );
      }
      return NextResponse.json({
        node: { id: node.id, slug: node.slug },
        env: targetEnv,
        placement,
        result,
      });
    }

    // REGION verb (story.5050): require this env's workload to be placed in `countries`. The
    // node-deploy sequencer reads the cell on its next release, which mints a fresh lease, so no
    // lease_generation moves with it (task.5411).
    if (hasCountries) {
      let result: Awaited<ReturnType<typeof writer.openNodeRegionPr>>;
      try {
        result = await writer.openNodeRegionPr({
          owner,
          repo,
          slug: node.slug,
          env: targetEnv as NodeFormationEnv,
          countries: countries as readonly string[],
        });
      } catch (err) {
        const status = (err as { status?: number })?.status;
        const code = (err as { code?: string })?.code;
        const reason = err instanceof Error ? err.message : "unknown";
        return NextResponse.json(
          { error: "node region write failed", errorCode: code, reason },
          { status: typeof status === "number" ? status : 502 }
        );
      }
      return NextResponse.json({
        node: { id: node.id, slug: node.slug },
        env: targetEnv,
        countries,
        result,
      });
    }

    // DEACTIVATE_ENUMERATES_THE_MONEY (story.5039 PR-B): a REMOVE reads the env's LIVE paid leases
    // (`listAllocated`) before the PR opens, best-effort — `openLeases: null` degrades, never blocks.
    // An ADD reads nothing: the node-deploy verb mints its own lease per release (task.5411).
    const leaseRead = getContainer().leaseReadCapability;
    let envReceipts: readonly AkashTxAllocationRecord[] | null = null;
    if (present === false && leaseRead) {
      try {
        envReceipts = await leaseRead.listAllocated({
          nodeId: node.id,
          environment: targetEnv,
          limit: LEASE_ENUMERATION_LIMIT,
        });
      } catch (err) {
        ctx.log.warn(
          {
            nodeId: node.id,
            env: targetEnv,
            causeMessage: err instanceof Error ? err.message : "unknown",
          },
          "node_envs_lease_read_failed"
        );
      }
    }

    let result: Awaited<ReturnType<typeof writer.openNodeEnvPr>>;
    try {
      result = await writer.openNodeEnvPr({
        owner,
        repo,
        slug: node.slug,
        env: targetEnv as (typeof NODE_DEPLOY_ENVS)[number],
        present: present as boolean,
      });
    } catch (err) {
      const status = (err as { status?: number })?.status;
      const code = (err as { code?: string })?.code;
      const reason = err instanceof Error ? err.message : "unknown";
      return NextResponse.json(
        { error: "node env-membership write failed", errorCode: code, reason },
        { status: typeof status === "number" ? status : 502 }
      );
    }

    return NextResponse.json({
      node: { id: node.id, slug: node.slug },
      env: targetEnv,
      present,
      result,
      // ADD_DERIVES_PLACEMENT (story.5039): what the writer derived for a `present:true` request —
      // placement/compute authority/control env are catalog-derived facts, never caller input.
      ...(present === true && result.derived
        ? { derived: result.derived }
        : {}),
      // DEACTIVATE_ENUMERATES_THE_MONEY (story.5039 PR-B): the live leases this removal
      // displaces, and where to prove them closed. `openLeases: null` = the ledger
      // could not be read (capability unwired or read failed) — deliberately distinct from `[]`.
      ...(present === false
        ? {
            openLeases: envReceipts ? envReceipts.map(toOpenLease) : null,
            verify: `/api/v1/nodes/${node.id}/deploy-state`,
          }
        : {}),
    });
  }
);
