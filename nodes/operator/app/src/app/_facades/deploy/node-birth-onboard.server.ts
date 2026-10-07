// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Merged operator node-register PR -> exact child candidate flight.
 *
 * The candidate workflow owns ordering: a foreign-custodied Akash target first
 * reconciles and asserts candidate-a substrate with the control environment's
 * credentials, then (and only then) mutates the candidate deploy branch. This
 * facade only authenticates the birth operation and dispatches that existing
 * primitive. It never receives secret values or promotes production.
 */

import type { Logger } from "pino";
import { parse as parseYaml } from "yaml";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import type { ServerEnv } from "@/shared/env";
import { EVENT_NAMES } from "@/shared/observability";

const BRANCH = /^cogni-operator\/node-register-([a-z0-9][a-z0-9-]{0,62})$/;
const SHA = /^[0-9a-f]{40}$/i;

interface BirthContext {
  readonly owner: string;
  readonly repo: string;
  readonly prNumber: number;
  readonly branchSlug: string;
  readonly mergeSha: string;
}

interface CatalogRow {
  readonly name?: string;
  readonly node_id?: string;
  readonly source_sha?: string;
  readonly envs?: readonly string[];
}

function extractBirth(
  payload: Record<string, unknown>,
  env: ServerEnv
): BirthContext | null {
  if (payload.action !== "closed") return null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const repo = payload.repository as Record<string, unknown> | undefined;
  if (!pr || !repo || pr.merged !== true) return null;
  const owner = (repo.owner as Record<string, unknown> | undefined)?.login;
  const name = repo.name;
  const prNumber = pr.number;
  const headRef = (pr.head as Record<string, unknown> | undefined)?.ref;
  const mergeSha = pr.merge_commit_sha;
  if (
    typeof owner !== "string" ||
    typeof name !== "string" ||
    typeof prNumber !== "number" ||
    typeof headRef !== "string" ||
    typeof mergeSha !== "string" ||
    !SHA.test(mergeSha) ||
    owner.toLowerCase() !== env.NODE_SUBMODULE_PARENT_OWNER.toLowerCase() ||
    name.toLowerCase() !== env.NODE_SUBMODULE_PARENT_REPO.toLowerCase()
  ) {
    return null;
  }
  const branchSlug = BRANCH.exec(headRef)?.[1];
  return branchSlug
    ? { owner, repo: name, prNumber, branchSlug, mergeSha }
    : null;
}

export async function dispatchNodeBirthOnboard(
  payload: Record<string, unknown>,
  env: ServerEnv,
  log: Logger
): Promise<void> {
  const ctx = extractBirth(payload, env);
  if (!ctx) return;
  if (!env.GH_REVIEW_APP_ID || !env.GH_REVIEW_APP_PRIVATE_KEY_BASE64) {
    log.debug("node birth onboard skipped — GitHub App not configured");
    return;
  }

  const base = {
    event: EVENT_NAMES.NODE_BIRTH_ONBOARD_COMPLETE,
    slug: ctx.branchSlug,
    prNumber: ctx.prNumber,
    mergeSha8: ctx.mergeSha.slice(0, 8),
  };

  try {
    const deployPlane = createOperatorDeployPlane(env);
    const classified = await deployPlane.classifyNodeRegisterPr({
      owner: ctx.owner,
      repo: ctx.repo,
      prNumber: ctx.prNumber,
    });
    if (!classified.isNodeRegisterPr || classified.slug !== ctx.branchSlug) {
      log.warn(
        { ...base, outcome: "skipped", errorCode: "not_app_signed_birth" },
        EVENT_NAMES.NODE_BIRTH_ONBOARD_COMPLETE
      );
      return;
    }

    const catalogText = await deployPlane.fetchFileText({
      owner: ctx.owner,
      repo: ctx.repo,
      path: `infra/catalog/${ctx.branchSlug}.yaml`,
      ref: "main",
    });
    if (!catalogText) {
      throw Object.assign(new Error("catalog absent"), {
        code: "catalog_absent",
      });
    }
    const row = parseYaml(catalogText) as CatalogRow;
    if (
      row.name !== ctx.branchSlug ||
      typeof row.node_id !== "string" ||
      typeof row.source_sha !== "string" ||
      !SHA.test(row.source_sha) ||
      !row.envs?.includes("candidate-a")
    ) {
      throw Object.assign(new Error("invalid merged birth catalog"), {
        code: "invalid_birth_catalog",
      });
    }

    const prepared = await deployPlane.prepareNodeRefCandidateFlight({
      parentOwner: ctx.owner,
      parentRepo: ctx.repo,
      nodeId: row.node_id,
      slug: ctx.branchSlug,
      sourceSha: row.source_sha,
    });
    const result = await deployPlane.dispatchNodeBirthCandidateFlight({
      owner: ctx.owner,
      repo: ctx.repo,
      slug: prepared.slug,
      sourceSha: prepared.sourceSha,
      mergeSha: ctx.mergeSha,
    });
    log.info(
      {
        ...base,
        outcome: result.status,
        sourceSha8: prepared.sourceSha.slice(0, 8),
        workflowUrl: result.workflowUrl,
      },
      EVENT_NAMES.NODE_BIRTH_ONBOARD_COMPLETE
    );
  } catch (error) {
    log.error(
      {
        ...base,
        outcome: "error",
        errorCode:
          error && typeof error === "object" && "code" in error
            ? String((error as { code: unknown }).code)
            : "node_birth_onboard_failed",
      },
      EVENT_NAMES.NODE_BIRTH_ONBOARD_COMPLETE
    );
    throw error;
  }
}
