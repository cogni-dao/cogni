// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/deploy/operator-change-recovery.server`
 * Purpose: Durable operator-change execution, including post-CAS node-birth flight dispatch.
 * Scope: Delegates a strict request to VcsCapability, validates the semantic result, and for an
 *   exactly landed node.register intent invokes the existing node-ref candidate-flight primitive.
 * Invariants:
 *   - VERIFIED_INTENT_ONLY: node identity and source SHA come only from the strict workflow input.
 *   - EXACT_LANDING_BEFORE_FLIGHT: regeneration, equivalent intent, and terminal outcomes do not
 *     dispatch; only this exact head's landed/read-back results may proceed.
 *   - AT_LEAST_ONCE_CONVERGENCE: an ambiguous dispatch throws so Temporal retries the same
 *     node+source pair; no pre-dispatch receipt can strand the operation.
 * Side-effects: GitHub reads/writes through VcsCapability and DeployPlanePort.
 * Links: task.5188, task.5195
 * @internal
 */

import {
  type OperatorChangeRecoveryRequest,
  type OperatorChangeRecoveryResult,
  OperatorChangeRecoveryResultSchema,
} from "@cogni/node-contracts";
import type { DeployPlanePort } from "@/ports";

export interface OperatorChangeRecoveryCapability {
  recoverOperatorChange(
    request: OperatorChangeRecoveryRequest
  ): Promise<OperatorChangeRecoveryResult>;
}

function canonicalGithubRepository(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\.git$/i, "").replace(/^\//, "");
  const parts = path.split("/");
  if (
    url.protocol !== "https:" ||
    url.hostname.toLowerCase() !== "github.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    throw Object.assign(new Error("invalid prepared node source repository"), {
      status: 409,
    });
  }
  return parts.join("/").toLowerCase();
}

export async function recoverOperatorChange(
  input: OperatorChangeRecoveryRequest,
  vcs: OperatorChangeRecoveryCapability,
  deployPlane: Pick<
    DeployPlanePort,
    "prepareNodeRefCandidateFlight" | "dispatchNodeRefCandidateFlight"
  >
): Promise<OperatorChangeRecoveryResult> {
  const result = OperatorChangeRecoveryResultSchema.parse(
    await vcs.recoverOperatorChange(input)
  );
  const exactHeadLanded =
    result.status === "landed" ||
    (result.status === "satisfied" &&
      (result.reason === "main_equals_losing_head" ||
        result.reason === "exact_pr_merged"));
  if (input.intent.operation === "node.register" && exactHeadLanded) {
    const prepared = await deployPlane.prepareNodeRefCandidateFlight({
      parentOwner: input.owner,
      parentRepo: input.repo,
      nodeId: input.intent.nodeId,
      slug: input.intent.node,
      sourceSha: input.intent.sourceSha,
    });
    if (
      prepared.nodeId !== input.intent.nodeId ||
      prepared.slug !== input.intent.node ||
      prepared.sourceSha !== input.intent.sourceSha ||
      canonicalGithubRepository(prepared.sourceRepo) !==
        canonicalGithubRepository(input.intent.sourceRepo)
    ) {
      throw Object.assign(
        new Error(
          "prepared node flight does not match verified register intent"
        ),
        { status: 409 }
      );
    }
    await deployPlane.dispatchNodeRefCandidateFlight({
      owner: input.owner,
      repo: input.repo,
      slug: input.intent.node,
      sourceSha: input.intent.sourceSha,
    });
  }
  return result;
}
