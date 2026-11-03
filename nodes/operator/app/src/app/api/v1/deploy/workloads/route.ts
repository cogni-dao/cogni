// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/api/v1/deploy/workloads`
 * Purpose: The node-deploy verb's front door (task.5400, story.5127). `POST` records the intent to
 *   deploy ONE declared workload at a source sha; `GET` reads the desired row with its explicit
 *   release state (queued|deploying|active|parked|superseded|failed), the active attempt and recent
 *   attempts with their step timelines (`releases/{releaseId}` is the per-release detail).
 * Scope: Authorizes per env, resolves the node's OWN source repo and image repository from the catalog
 *   baked into the operator image (the one the sequencer uses, the same in every env), reads that repo's
 *   `.cogni/repo-spec.yaml` and every workload manifest (`.cogni/workloads/*.yaml`) AT `sourceSha` through
 *   the operator GitHub App, or anonymously when the repo is public and the App is not installed on it, resolves a manifest image of `.` to the digest node
 *   CI built at that sha, checks and lowers the manifests, resolves the one requested workload, and
 *   writes an immutable release plus the desired row in one transaction. It never calls the actuator
 *   and never touches DNS: the sequencer executes the intent.
 * Invariants:
 *   - AUTHZ_BEFORE_SIDE_EFFECT: production needs `node.promote_production` (`can_promote_production`);
 *     candidate-a and preview need `node.manage_envs` (`can_manage_envs`) — the promote route's pattern —
 *     checked before any GitHub read or write. GET uses the same gate.
 *   - INTENT_ONLY: a 200 means a release row exists, not that anything is deployed.
 *   - DECLARED_AT_THE_SHA: the manifests and the repo-spec are read at the requested sha from the
 *     node's repo, and the repo-spec `node_id` must equal the requested node.
 *   - NODE_DEPLOYS_FROM_ITS_OWN_REPO: the repo comes from the node's row in the IMAGE catalog
 *     (`createNodeSourceResolver`, story.5137), never from a GitHub read of an env-specific parent repo,
 *     so flight and production are the same call: a remote-source node reads its own `source_repo` and
 *     image repository; an in-repo node (the operator) reads the parent repo and resolves no built image.
 *   - READ_NEEDS_NO_NEW_SECRET: the App read is tried first; a public repo the App is not installed on
 *     is read anonymously (read-only). Nothing is ever written to a node repo.
 *   - BUILT_IMAGE_IS_DIGEST_PINNED: an image of `.` becomes `<image_repository>@sha256:<digest>` for
 *     `sha-<sourceSha>`. An image that does not exist is 422 `built_image_not_found` before any write.
 *   - REFUSED_BEFORE_PAID_CREATE: a manifest the two-pass check refuses returns 422
 *     `workload_manifest_refused` with every issue; no release row is written.
 *   - STATE_IS_CREATE_ONCE: a `state` workload that already has a desired row is refused with 409; a
 *     state lease is never replaced by a deploy.
 *   - G4_STATE_ADMISSION: a new production `state` workload is refused 422 `state_admission_refused`
 *     until the off-provider backup debt row closes; the only exception is the operator node's own
 *     `canary-db`.
 *   - NO_SOURCE_ECHO: a 502 read failure never returns the GitHub/Octokit message.
 * Side-effects: IO (authz check, image catalog file read, GitHub App or anonymous contents read,
 *   anonymous ghcr.io manifest read, operator Postgres write)
 * Links: contracts/deploy.workloads.v1.contract.ts, features/node-deploy/declarations.ts,
 *   features/node-deploy/read-declarations.ts, ports/built-image.port.ts,
 *   packages/repo-spec/src/workload-manifest.ts, docs/spec/rbac.md, hub `node-service-delivery`,
 *   hub `workload-manifest`
 * @public
 */

import { NextResponse } from "next/server";
import { getSessionUser } from "@/app/_lib/auth/session";
import { createBuiltImageResolver } from "@/bootstrap/capabilities/built-image-resolver";
import { createNodeDeployStore } from "@/bootstrap/capabilities/node-deploy-store";
import {
  createDeclarationReader,
  createNodeSourceResolver,
} from "@/bootstrap/capabilities/node-source-resolver";
import { wrapRouteHandlerWithLogging } from "@/bootstrap/http";
import {
  DeployWorkloadInputSchema,
  DeployWorkloadQuerySchema,
} from "@/contracts/deploy.workloads.v1.contract";
import {
  DeclarationError,
  needsBuiltImage,
  resolveWorkloadDeclaration,
} from "@/features/node-deploy/declarations";
import {
  readWorkloadDeclarations,
  type WorkloadDeclarationsRead,
} from "@/features/node-deploy/read-declarations";
import { buildWorkloadView } from "@/features/node-deploy/release-view";
import { BuiltImageRegistryError, type ResolvedNodeSource } from "@/ports";
import { getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";
import { EVENT_NAMES, logEvent } from "@/shared/observability";

import { envNotServed, gate } from "./_lib/gate";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * G4 canary-only exception: the one production state workload admitted before backups exist. It
 * holds only for the operator's OWN node (`getNodeId()`), never for another node's `canary-db`.
 */
const G4_PRODUCTION_STATE_EXCEPTION = "canary-db";

export const POST = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.workloads.record",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      }
      const parsed = DeployWorkloadInputSchema.safeParse(body);
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env, workload, sourceSha } = parsed.data;

      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const node = g.node;
      const wrongEnv = envNotServed(env);
      if (wrongEnv) return wrongEnv;

      const envConfig = serverEnv();
      const owner = envConfig.NODE_SUBMODULE_PARENT_OWNER;
      const repo = envConfig.NODE_SUBMODULE_PARENT_REPO;
      if (!owner || !repo)
        return NextResponse.json(
          { error: "deploy_target_not_configured" },
          { status: 503 }
        );

      let source: ResolvedNodeSource;
      let read: WorkloadDeclarationsRead;
      try {
        source = await createNodeSourceResolver().resolveNodeSource({
          nodeId: node.id,
          parentOwner: owner,
          parentRepo: repo,
        });
        read = await readWorkloadDeclarations(
          createDeclarationReader(envConfig),
          {
            owner: source.owner,
            repo: source.repo,
            sourceSha,
          }
        );
      } catch (error) {
        if ((error as { code?: unknown })?.code === "catalog_missing")
          return NextResponse.json(
            { error: "catalog_missing" },
            { status: 404 }
          );
        // NO_SOURCE_ECHO: never return the Octokit/GitHub message; log it for the operator instead.
        ctx.log.warn(
          {
            reqId: ctx.reqId,
            err:
              error instanceof Error ? error.message.slice(0, 300) : "unknown",
          },
          "node-deploy declaration read failed"
        );
        return NextResponse.json(
          {
            error: "declaration_read_failed",
            message: "could not read the declarations at this sha",
          },
          { status: 502 }
        );
      }
      if (read.kind === "repo_spec_not_found")
        return NextResponse.json(
          { error: "repo_spec_not_found" },
          { status: 422 }
        );
      if (read.kind === "refused")
        // NOTHING_SILENTLY_DROPPED: a non-*.yaml entry or too many manifests; every issue is returned.
        return NextResponse.json(
          {
            error: "workload_manifest_refused",
            message: read.message,
            issues: read.issues,
          },
          { status: 422 }
        );

      const declare = (builtImage?: string) =>
        resolveWorkloadDeclaration({
          repoSpecText: read.repoSpecText,
          manifests: read.manifests,
          nodeId: node.id,
          env,
          workload,
          builtImage,
        });
      let spec: ReturnType<typeof resolveWorkloadDeclaration>;
      try {
        try {
          spec = declare();
        } catch (error) {
          // An image of `.` needs the digest node CI built at this sha. Resolve it only when a
          // manifest asks for it, and only for a node that has an image repository.
          if (
            !(error instanceof DeclarationError) ||
            !needsBuiltImage(error) ||
            source.imageRepository === null
          )
            throw error;
          let builtImage: string | null;
          try {
            builtImage = await createBuiltImageResolver().resolveBuiltImage({
              imageRepository: source.imageRepository,
              sourceSha,
            });
          } catch (lookupError) {
            if (!(lookupError instanceof BuiltImageRegistryError))
              throw lookupError;
            ctx.log.warn(
              { reqId: ctx.reqId, err: lookupError.message },
              "node-deploy built image lookup failed"
            );
            return NextResponse.json(
              {
                error: "built_image_lookup_failed",
                message: "could not read the image registry; retry",
              },
              { status: 502 }
            );
          }
          if (builtImage === null)
            return NextResponse.json(
              {
                error: "built_image_not_found",
                message: `no public image ${source.imageRepository}:sha-${sourceSha}; build the node at this sha first`,
              },
              { status: 422 }
            );
          spec = declare(builtImage);
        }
      } catch (error) {
        if (error instanceof DeclarationError)
          return NextResponse.json(
            {
              error: error.code,
              message: error.message,
              ...(error.issues.length > 0 ? { issues: error.issues } : {}),
            },
            { status: error.code === "workload_not_declared" ? 404 : 422 }
          );
        throw error;
      }

      // G4: no NEW production state until the off-provider backup debt row closes (hub
      // node-service-delivery, debt ledger). `canary-db` is the one canary-only exception: it holds
      // canary boot rows, no user data. Lift this guard when that debt row closes.
      if (
        env === "production" &&
        spec.kind === "state" &&
        !(node.id === getNodeId() && workload === G4_PRODUCTION_STATE_EXCEPTION)
      )
        return NextResponse.json(
          {
            error: "state_admission_refused",
            message:
              "a new production state workload is refused until off-provider backups exist (G4)",
          },
          { status: 422 }
        );

      const store = createNodeDeployStore();
      if (spec.kind === "state") {
        const existing = await store.getDesired({
          nodeId: node.id,
          env,
          workload,
        });
        if (existing)
          return NextResponse.json(
            { error: "state_workload_exists" },
            { status: 409 }
          );
      }
      const { release, desired } = await store.recordRelease({
        nodeId: node.id,
        env,
        workload,
        sourceSha,
        spec,
        createdBy: `user:${sessionUser.id}`,
      });
      return NextResponse.json(
        {
          releaseId: release.id,
          nodeId: node.id,
          env,
          workload,
          sourceSha,
          desiredState: desired.state,
        },
        { status: 200 }
      );
    };
    try {
      response = await run();
      return response;
    } catch {
      response = NextResponse.json({ error: "record_failed" }, { status: 500 });
      return response;
    } finally {
      const status = response?.status ?? 500;
      logEvent(ctx.log, EVENT_NAMES.NODE_WORKLOAD_DEPLOY_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        targetNodeId,
        status,
        outcome: status < 400 ? "success" : "error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }
);

export const GET = wrapRouteHandlerWithLogging(
  {
    routeId: "deploy.workloads.read",
    auth: { mode: "required", getSessionUser },
  },
  async (ctx, request, sessionUser) => {
    const startedAt = performance.now();
    let response: NextResponse | undefined;
    let targetNodeId: string | undefined;
    const run = async (): Promise<NextResponse> => {
      const url = new URL(request.url);
      const parsed = DeployWorkloadQuerySchema.safeParse({
        nodeId: url.searchParams.get("nodeId") ?? undefined,
        env: url.searchParams.get("env") ?? undefined,
        ...(url.searchParams.get("workload")
          ? { workload: url.searchParams.get("workload") }
          : {}),
      });
      if (!parsed.success)
        return NextResponse.json({ error: "Invalid request" }, { status: 400 });
      const { nodeId, env, workload } = parsed.data;
      const g = await gate(sessionUser.id, nodeId, env);
      targetNodeId = g.ok ? g.node.id : undefined;
      if (!g.ok) return g.response;
      const wrongEnv = envNotServed(env);
      if (wrongEnv) return wrongEnv;

      const store = createNodeDeployStore();
      const rows = (await store.listDesired(env)).filter(
        (d) =>
          d.nodeId === g.node.id &&
          d.env === env &&
          (workload === undefined || d.workload === workload)
      );
      const out = [];
      for (const desired of rows) {
        // Release state, park reason, lead-time timestamps and per-attempt step timelines are
        // derived from the rows by `buildWorkloadView` (task.5400 observability).
        out.push(
          buildWorkloadView({
            desired,
            release: await store.getRelease(desired.releaseId),
            attemptsNewestFirst: await store.attemptsFor(desired),
          })
        );
      }
      return NextResponse.json(
        { nodeId: g.node.id, env, workloads: out },
        { status: 200 }
      );
    };
    try {
      response = await run();
      return response;
    } catch {
      response = NextResponse.json({ error: "read_failed" }, { status: 500 });
      return response;
    } finally {
      const status = response?.status ?? 500;
      logEvent(ctx.log, EVENT_NAMES.NODE_WORKLOAD_DEPLOY_COMPLETE, {
        reqId: ctx.reqId,
        routeId: ctx.routeId,
        targetNodeId,
        status,
        outcome: status < 400 ? "success" : "error",
        durationMs: Math.round(performance.now() - startedAt),
      });
    }
  }
);
