// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/nodes/[id]/envs`
 * Purpose: Node env-membership verb (story.5020 W4) — add OR remove ONE environment from a node's
 *   deploy reach by opening an operator-authored PR that edits the OPERATOR monorepo catalog
 *   (`infra/catalog/<slug>.yaml` `envs:` line + placement cells + the matching overlay /
 *   ApplicationSet / appsets kustomization). Individual memberships are independently editable, but
 *   the final environment and current `activity_env` cannot be removed. Full decommission and
 *   authority transfer are separate flows.
 *   PLUS the placement lever (story.5016 T5): `{env, placement: "k3s"|"akash"}` picks the serving lane
 *   for an env ALREADY in reach — akash upserts `deployment_provider.<env>` and removes the k3s
 *   overlay/AppSet (the ComputeWorkload CR lane takes over); k3s restores them. `present` and
 *   `placement` are MUTUALLY EXCLUSIVE (exactly one per request); deploy-straight-onto-akash is
 *   deliberately out of v1 scope — deploy first, then place.
 * Scope: Session auth + a single MANAGE_ENVS authz-gate on the resolved node. Resolves the monorepo
 *   owner/repo exactly like `publish` / `activate-payments` (env-scoped, FAIL CLOSED), then delegates the
 *   byte-exact catalog/overlay/appset edit to `GitHubRepoWriter.openNodeEnvPr`.
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
 *     read-back URL) in the response — the receipts the Argo prune → Crossplane REMOVE → actuator
 *     delete chain is expected to close. Enumeration only; the close itself never happens app-side.
 *   - GENERATION_IS_NOT_CALLER_INPUT / NOTHING_BUMPS_IMPLICITLY (lease-reactivation.ts): an add's
 *     `lease_generation` is DERIVED from ledger-receipt evidence (every state — a TERMINAL
 *     `released`/`failed` receipt forces the bump, task.5132), never taken from the request
 *     body, and becomes real only as the reviewed catalog commit this verb authors.
 *   - EVIDENCE_OR_REFUSE (task.5132): an ADD REFUSES (503 `generation_evidence_unavailable`)
 *     rather than guesses a generation — if the lease-read capability is unwired
 *     (AKASH_ACTUATOR_ACCOUNT_ID unpinned) or the ledger read fails, no PR opens. Falling back
 *     to catalogGeneration silently re-presented a spent gen-0 key on the live incident.
 *     The REMOVE enumeration stays best-effort (`openLeases: null` degrades, never blocks).
 *   - OBSERVABLE: wrapped in `wrapRouteHandlerWithLogging` (routeId `nodes.envs`) — every request
 *     emits the standard start/end envelope + metrics (validation finding on #2311: this verb
 *     previously logged nothing).
 * Side-effects: IO (GitHub REST API, Postgres read)
 * Links: src/adapters/server/vcs/github-repo-write.ts (openNodeEnvPr),
 *   src/shared/node-app-scaffold/gens/env-membership-plan.ts,
 *   src/features/compute/lease-reactivation.ts, docs/design/operator-fleet-safety.md, story.5020
 * @public
 */

import { NextResponse } from "next/server";

import { getSessionUser } from "@/app/_lib/auth/session";
import { resolveNodeAndAuthorize } from "@/app/_lib/node-rbac";
import { createNodeRepoWriter } from "@/bootstrap/capabilities/node-repo-write";
import { getContainer, resolveServiceDb } from "@/bootstrap/container";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import { requiredLeaseGeneration } from "@/features/compute/lease-reactivation";
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
    } = (body ?? {}) as {
      env?: unknown;
      present?: unknown;
      placement?: unknown;
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
    if (hasPresent === hasPlacement) {
      return NextResponse.json(
        {
          error: "invalid body",
          reason:
            "provide exactly one of `present` (boolean, deploy reach) or `placement` (k3s|akash, serving lane)",
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

    // Money-loop wiring (story.5039 PR-B). One (node, env)-scoped ledger read per direction:
    //   - REMOVE reads `listAllocated` — the env's LIVE paid leases, enumerated BEFORE the PR
    //     opens: what the Argo prune → Crossplane REMOVE → actuator delete chain is expected to
    //     close (embedded as `openLeases` + a `verify` URL for the read-back).
    //   - ADD reads `listReceipts` — receipts in EVERY state, because the evidence
    //     `requiredLeaseGeneration` derives the catalog's `lease_generation` cell from is
    //     exactly the TERMINAL (`released`/`failed`) receipts the allocated-only view hides
    //     (task.5132: deriving from `listAllocated` answered 0 over a terminally failed gen-0
    //     receipt, and the recreated XR's key was refused with `akash_tx_identity_conflict`).
    //     GENERATION_IS_NOT_CALLER_INPUT — the REST body never carries it;
    //     NOTHING_BUMPS_IMPLICITLY — it lands only as this verb's reviewed commit.
    // catalogGeneration is 0 here: an env being ADDED has no cell (REMOVE_COMPLETES_THE_ROW
    // drops it with the env), so the receipts are the only evidence that can force a bump.
    const leaseRead = getContainer().leaseReadCapability;
    const scope = {
      nodeId: node.id,
      environment: targetEnv,
      limit: LEASE_ENUMERATION_LIMIT,
    };
    let envReceipts: readonly AkashTxAllocationRecord[] | null = null;
    if (present === true) {
      // EVIDENCE_OR_REFUSE (task.5132): the ADD derivation is fail-closed. Without a readable
      // ledger the verb cannot distinguish "no prior lease" from "spent gen-0 key it must bump
      // past" — guessing (the old catalogGeneration fallback) authored a catalog PR that
      // re-presented a spent key and the actuator refused it with `akash_tx_identity_conflict`.
      if (!leaseRead) {
        return NextResponse.json(
          {
            error: "generation_evidence_unavailable",
            reason:
              "AKASH_ACTUATOR_ACCOUNT_ID is not pinned on this runtime — the ADD verb cannot derive lease_generation without reading the allocation ledger",
          },
          { status: 503 }
        );
      }
      try {
        envReceipts = await leaseRead.listReceipts(scope);
      } catch (err) {
        ctx.log.warn(
          {
            nodeId: node.id,
            env: targetEnv,
            errorCode: "generation_evidence_unavailable",
            causeMessage: err instanceof Error ? err.message : "unknown",
          },
          "node_envs_lease_read_failed"
        );
        return NextResponse.json(
          {
            error: "generation_evidence_unavailable",
            reason:
              "the allocation-ledger read failed — the ADD verb refuses to guess lease_generation without receipt evidence",
          },
          { status: 503 }
        );
      }
    } else if (leaseRead) {
      // REMOVE enumeration stays best-effort: `openLeases: null` degrades, never blocks.
      try {
        envReceipts = await leaseRead.listAllocated(scope);
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
    const leaseGeneration =
      present === true && envReceipts
        ? requiredLeaseGeneration({
            catalogGeneration: 0,
            receipts: envReceipts,
          })
        : undefined;

    let result: Awaited<ReturnType<typeof writer.openNodeEnvPr>>;
    try {
      result = await writer.openNodeEnvPr({
        owner,
        repo,
        slug: node.slug,
        env: targetEnv as (typeof NODE_DEPLOY_ENVS)[number],
        present: present as boolean,
        leaseGeneration,
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
      // DEACTIVATE_ENUMERATES_THE_MONEY (story.5039 PR-B): the receipts the Argo→Crossplane
      // chain is expected to close, and where to prove it. `openLeases: null` = the ledger
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
