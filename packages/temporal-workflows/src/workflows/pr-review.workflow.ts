// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/workflows/pr-review`
 * Purpose: Temporal parent workflow for webhook-triggered PR review.
 * Scope: Deterministic orchestration only. Does not perform I/O — all external calls in Activities, LLM in GraphRunWorkflow child.
 * Invariants:
 *   - Per TEMPORAL_DETERMINISM: No I/O in workflow code
 *   - Per NORMATIVE_WEBHOOK_PATTERN: webhook starts workflow, exits immediately
 *   - Per NODE_REVIEW_OPT_OUT: context is fetched BEFORE the Check Run so a node
 *     that sets repo-spec `review.enabled: false` gets a fully silent skip (no
 *     Check Run, no comment, no AI tokens). Model is node-selected via
 *     `review.model` → `context.modelRef` (no operator-side model hardcode).
 *   - Per ACTIVITY_IDEMPOTENCY: GitHub writes use stable business keys (repo/pr/headSha)
 *   - Per WORKFLOW_TOP_LEVEL_VISIBILITY: parent workflow is primary UI object; graph run is drill-down
 *   - Per SINGLE_DOMAIN_HARD_FAIL: workflow short-circuits cross-domain (`conflict`) and
 *     unrecognized-scope (`miss`) PRs through `postRoutingDiagnosticActivity` — no AI
 *     tokens spent. Owning domain is resolved inside `fetchPrContextActivity` via
 *     `extractOwningNode`; the workflow only dispatches on `kind`.
 *   - TYPED_TERMINAL_ARTIFACT: GraphRunWorkflow child returns structuredOutput for parent consumption
 *   - Per SINGLE_INPUT_CONTRACT (task.0419): input shape is defined exactly once
 *     in `./pr-review.schema.ts` and consumed via `z.infer<>` — no parallel TS
 *     interfaces. Producers parse with `PrReviewWorkflowInputSchema` before
 *     `workflowClient.start(...)`.
 * Side-effects: none (deterministic orchestration only)
 * Links: docs/spec/temporal-patterns.md, docs/spec/node-ci-cd-contract.md#single-domain-scope, task.0191, task.0410, task.0419
 * @public
 */

import { executeChild, proxyActivities, uuid4 } from "@temporalio/workflow";
import { EXTERNAL_API_ACTIVITY_OPTIONS } from "../activity-profiles.js";
import type { ReviewActivities } from "../activity-types.js";
import type { GraphRunResult } from "./graph-run.workflow.js";
import type { PrReviewWorkflowInput } from "./pr-review.schema.js";

// All review activities: GitHub API calls with 5-min timeout, 3 retries
const {
  createCheckRunActivity,
  fetchPrContextActivity,
  postReviewResultActivity,
  postRoutingDiagnosticActivity,
} = proxyActivities<ReviewActivities>(EXTERNAL_API_ACTIVITY_OPTIONS);

/**
 * Input for PrReviewWorkflow — re-exported from the Zod schema source-of-truth
 * (`./pr-review.schema.ts`). Per SINGLE_INPUT_CONTRACT: do not duplicate the
 * shape as a parallel TS interface. See task.0419 / PR #1067 for context.
 */
export {
  type PrReviewWorkflowInput,
  PrReviewWorkflowInputSchema,
} from "./pr-review.schema.js";

/**
 * PrReviewWorkflow — Temporal parent workflow for PR review.
 *
 * Flow:
 * 1. Activity: createCheckRun (GitHub "in_progress" — immediate UX feedback)
 * 2. Activity: fetchPrContext (GitHub API reads — evidence, repo-spec, rules)
 * 3. Child: GraphRunWorkflow(pr-review) → structured evaluation output
 * 4. Activity: postReviewResult (evaluate criteria, format markdown, GitHub writes)
 *
 * Idempotency: workflowId = pr-review:{owner}/{repo}/{prNumber}/{headSha}
 * Retries on the same headSha produce the same external result (idempotent check run + comment).
 */
export async function PrReviewWorkflow(
  input: PrReviewWorkflowInput
): Promise<void> {
  const {
    nodeId,
    owner,
    repo,
    prNumber,
    headSha,
    installationId,
    actorUserId,
    billingAccountId,
    virtualKeyId,
  } = input;

  // 1. Fetch PR context from GitHub API FIRST. The activity reads the target
  //    repo's own repo-spec, so it tells us whether this node even opts into
  //    review (`review.enabled`) and resolves the owning domain
  //    (extractOwningNode) so the workflow can dispatch on it without I/O.
  const context = await fetchPrContextActivity({
    owner,
    repo,
    prNumber,
    installationId,
  });

  // 1a. Review opt-out — when the node disables review in its repo-spec, the
  //     operator stays out entirely: no Check Run, no comment, no AI tokens.
  //     Fetching context before creating the Check Run is what makes "off" silent.
  if (context.reviewEnabled === false) {
    return;
  }

  // 2. Create Check Run for UX feedback (review is enabled for this node).
  let checkRunId: number | undefined;
  try {
    checkRunId = await createCheckRunActivity({
      owner,
      repo,
      headSha,
      installationId,
    });
  } catch {
    // Continue without check run — non-fatal
  }

  // 2a. Routing — short-circuit conflict / miss without spending AI tokens.
  //     Per docs/spec/node-ci-cd-contract.md § Single-Domain Scope, cross-domain
  //     PRs are refused at review-time mirroring the CI gate's verdict.
  if (context.owningNode.kind !== "single") {
    await postRoutingDiagnosticActivity({
      owner,
      repo,
      prNumber,
      headSha,
      installationId,
      checkRunId,
      owningNode: context.owningNode,
      changedFiles: context.changedFiles,
    });
    return;
  }

  // If no gates configured, mark check run as pass and exit
  if (context.gatesConfig.gates.length === 0) {
    if (checkRunId) {
      await postReviewResultActivity({
        owner,
        repo,
        prNumber,
        headSha,
        installationId,
        checkRunId,
        conclusion: "pass",
        gateResults: [],
        noGatesConfigured: true,
      });
    }
    return;
  }

  // 3. Execute pr-review graph as child workflow
  //    GraphRunWorkflow creates graph_runs record + publishes to Redis
  const runId = uuid4();
  let graphResult: GraphRunResult;
  try {
    graphResult = await executeChild("GraphRunWorkflow", {
      workflowId: `graph-run:system:pr-review:${owner}/${repo}/${prNumber}/${headSha}`,
      args: [
        {
          nodeId,
          graphId: `langgraph:pr-review`,
          executionGrantId: null,
          input: {
            messages: context.graphMessages,
            modelRef: context.modelRef,
            responseFormat: context.responseFormat,
            actorUserId,
            billingAccountId,
            virtualKeyId,
          },
          runKind: "system_webhook" as const,
          triggerSource: "webhook:github_pr",
          triggerRef: `pr-review:${owner}/${repo}/${prNumber}/${headSha}`,
          requestedBy: actorUserId,
          runId,
        },
      ],
    });
  } catch {
    // Graph child failed — still update check run to neutral so it doesn't hang
    graphResult = { ok: false, runId };
  }

  // 4. Post review results to GitHub
  await postReviewResultActivity({
    owner,
    repo,
    prNumber,
    headSha,
    installationId,
    checkRunId,
    graphResult,
    gatesConfig: context.gatesConfig,
    rules: context.rules,
    evidence: context.evidence,
    repoSpecYaml: context.repoSpecYaml,
  });
}
