// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/review/code-subject`
 * Purpose: Validate a graph run's requested code subject before it is bound to the run's
 *   execution scope (story.5102 REVIEW_SUBJECT_IS_HOST_BOUND).
 * Scope: Pure decision (`decideCodeSubject`) + the IO wrapper used by the internal graph run
 *   route (catalog lookup, node lookup, `resolveNodeRepo`). Does not read code.
 * Invariants:
 *   - CATALOG_DECLARES_SUBJECT: only graphs whose catalog entry sets `codeSubject: true` may
 *     receive one; any other graph carrying a subject is refused (400).
 *   - SUBJECT_IS_SELF_OR_LISTED (task.5448): a subject is this node itself or a node listed in
 *     `.cogni/service-links.yaml` (the same reader the review route and the node-code capability use);
 *     any other node is refused (403 `code_subject_node_not_linked`) before the repo check.
 *   - SUBJECT_REPO_IS_RESOLVED: owner/repo must equal `resolveNodeRepo(subject.nodeId)`
 *     (case-insensitive); a mismatch or unknown node is refused (403). The model never chooses it.
 * Side-effects: IO (service-db node lookup, catalog read through the deploy plane) in
 *   `resolveRunCodeSubject` only.
 * Links: story.5102, https://cognidao.org/knowledge/pr-review-grounded-gate,
 *   src/app/api/internal/graphs/[graphId]/runs/route.ts
 * @internal
 */

import { LANGGRAPH_CATALOG } from "@cogni/operator-graphs";
import { ReviewCodeSubjectSchema } from "@cogni/temporal-workflows";
import type { ExecutionCodeSubject } from "@/adapters/server";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { resolveServiceDb } from "@/bootstrap/container";
import { resolveNodeRef } from "@/features/nodes/node-lookup";
import { findServiceLinkTarget, getNodeId } from "@/shared/config";
import { serverEnv } from "@/shared/env";

export type CodeSubjectDecision =
  | { readonly ok: true; readonly codeSubject?: ExecutionCodeSubject }
  | {
      readonly ok: false;
      readonly status: 400 | 403 | 503;
      readonly error: string;
    };

/** Pure decision over an already-parsed subject, the catalog flag and the resolved repo. */
export function decideCodeSubject(input: {
  readonly subject: ExecutionCodeSubject;
  readonly catalogDeclares: boolean;
  readonly resolvedRepo: {
    readonly owner: string;
    readonly repo: string;
  } | null;
  /** This node's id: a subject equal to it needs no listing. */
  readonly selfNodeId: string;
  /** True when the subject's node id is a listed service-link target. */
  readonly subjectIsListed: boolean;
}): CodeSubjectDecision {
  if (!input.catalogDeclares) {
    return { ok: false, status: 400, error: "code_subject_not_accepted" };
  }
  if (input.subject.nodeId !== input.selfNodeId && !input.subjectIsListed) {
    return { ok: false, status: 403, error: "code_subject_node_not_linked" };
  }
  if (!input.resolvedRepo) {
    return { ok: false, status: 403, error: "code_subject_node_unknown" };
  }
  const same =
    input.resolvedRepo.owner.toLowerCase() ===
      input.subject.owner.toLowerCase() &&
    input.resolvedRepo.repo.toLowerCase() === input.subject.repo.toLowerCase();
  if (!same) {
    return { ok: false, status: 403, error: "code_subject_repo_mismatch" };
  }
  return { ok: true, codeSubject: input.subject };
}

/** Validate `input.codeSubject` of an internal graph run. Absent → no subject. */
export async function resolveRunCodeSubject(
  graphId: string,
  raw: unknown
): Promise<CodeSubjectDecision> {
  if (raw === undefined || raw === null) return { ok: true };
  const parsed = ReviewCodeSubjectSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, status: 400, error: "code_subject_invalid" };
  }
  const subject = parsed.data;
  const graphName = graphId.startsWith("langgraph:")
    ? graphId.slice("langgraph:".length)
    : undefined;
  const catalogDeclares =
    graphName !== undefined &&
    LANGGRAPH_CATALOG[graphName]?.codeSubject === true;
  // One reader of the listed link targets, shared with the review route and the node-code capability.
  const listing = {
    selfNodeId: getNodeId(),
    subjectIsListed: findServiceLinkTarget(subject.nodeId) !== undefined,
  };
  if (!catalogDeclares) {
    return decideCodeSubject({
      subject,
      catalogDeclares,
      resolvedRepo: null,
      ...listing,
    });
  }

  const env = serverEnv();
  if (!env.NODE_SUBMODULE_PARENT_OWNER || !env.NODE_SUBMODULE_PARENT_REPO) {
    return { ok: false, status: 503, error: "code_subject_unresolvable" };
  }
  const node = await resolveNodeRef(resolveServiceDb(), subject.nodeId);
  if (!node || node.nodeId !== subject.nodeId) {
    return decideCodeSubject({
      subject,
      catalogDeclares,
      resolvedRepo: null,
      ...listing,
    });
  }
  let resolvedRepo: { owner: string; repo: string };
  try {
    resolvedRepo = await createOperatorDeployPlane(env).resolveNodeRepo({
      parentOwner: env.NODE_SUBMODULE_PARENT_OWNER,
      parentRepo: env.NODE_SUBMODULE_PARENT_REPO,
      slug: node.slug,
    });
  } catch (error) {
    const code = (error as { code?: string })?.code;
    return code === "catalog_missing"
      ? decideCodeSubject({
          subject,
          catalogDeclares,
          resolvedRepo: null,
          ...listing,
        })
      : { ok: false, status: 503, error: "code_subject_unresolvable" };
  }
  return decideCodeSubject({
    subject,
    catalogDeclares,
    resolvedRepo,
    ...listing,
  });
}
