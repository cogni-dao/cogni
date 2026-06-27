// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/review/review-handler`
 * Purpose: Lock the ReviewHandlerDeps adapter boundary + verdict pipeline contract.
 * Scope: Pure DI fakes — no GitHub, no LLM, no Octokit, no filesystem.
 * Invariants: Empty-gates means silent skip; ai-rule model comes from the rule.
 * Side-effects: none
 * Links: task.0368
 * @public
 */

import type { GraphFinal, GraphRunResult } from "@cogni/graph-execution-core";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { ReviewHandlerDeps } from "@/features/review/services/review-handler";
import { handlePrReview } from "@/features/review/services/review-handler";
import type {
  EvidenceBundle,
  ReviewContext,
  ReviewRunContext,
} from "@/features/review/types";
import type { GraphExecutorPort } from "@/ports";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";

const REPO_SPEC_WITH_AI_RULE = `node_id: "${NODE_ID}"
governance:
  chain_id: "8453"
gates:
  - type: ai-rule
    with:
      rule_file: test-rule.yaml
`;

const REPO_SPEC_EMPTY_GATES = `node_id: "${NODE_ID}"
governance:
  chain_id: "8453"
gates: []
`;

const ctx: ReviewContext = {
  owner: "Cogni-DAO",
  repo: "node-template",
  prNumber: 42,
  headSha: "deadbeef0000000000000000000000000000cafe",
  installationId: 12345,
};

const evidence: EvidenceBundle = {
  prNumber: 42,
  prTitle: "test PR",
  prBody: "",
  headSha: ctx.headSha,
  baseBranch: "main",
  changedFiles: 3,
  additions: 50,
  deletions: 10,
  patches: [{ filename: "src/foo.ts", patch: "@@ -1 +1 @@\n+x" }],
  totalDiffBytes: 64,
};

function makeLog(): Logger {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    silent: vi.fn(),
  } as unknown as Logger;
  (log as unknown as { child: () => Logger }).child = () => log;
  return log;
}

function makeGraphFinal(score: number): GraphFinal {
  return {
    ok: true,
    runId: "run-1",
    requestId: "req-1",
    finishReason: "stop",
    structuredOutput: {
      metrics: [
        {
          metric: "foo",
          value: score,
          observations: ["observation text"],
        },
      ],
      summary: `score=${score}`,
    },
  };
}

async function* emptyStream(): AsyncIterable<never> {}

function makeExecutor(score: number): GraphExecutorPort {
  return {
    runGraph: vi.fn(
      (): GraphRunResult => ({
        stream: emptyStream(),
        final: Promise.resolve(makeGraphFinal(score)),
      })
    ),
  };
}

function makeReviewContext(opts: {
  readonly repoSpec?: string;
  readonly evidence?: EvidenceBundle;
  readonly owningNode?: ReviewRunContext["owningNode"];
}): ReviewRunContext {
  const empty = opts.repoSpec === REPO_SPEC_EMPTY_GATES;
  return {
    evidence: opts.evidence ?? evidence,
    gatesConfig: empty
      ? { gates: [], failOnError: false }
      : {
          gates: [
            {
              type: "ai-rule",
              with: { rule_file: "test-rule.yaml" },
            },
          ],
          failOnError: false,
        },
    rules: {
      "test-rule.yaml": {
        id: "test-rule",
        schema_version: "0.3",
        blocking: true,
        workflow_id: "goal-evaluations",
        model: "gpt-4o-mini",
        evaluations: [{ foo: "Evaluate metric foo on a 0-1 scale." }],
        success_criteria: {
          neutral_on_missing_metrics: false,
          require: [{ metric: "foo", gte: 0.8 }],
        },
      },
    },
    repoSpecYaml: opts.repoSpec ?? REPO_SPEC_WITH_AI_RULE,
    changedFiles: ["src/foo.ts"],
    owningNode: opts.owningNode ?? {
      kind: "single",
      nodeId: NODE_ID,
      path: ".",
    },
  };
}

interface DepsBundle {
  readonly deps: ReviewHandlerDeps;
  readonly createCheckRun: ReturnType<typeof vi.fn>;
  readonly updateCheckRun: ReturnType<typeof vi.fn>;
  readonly loadReviewContext: ReturnType<typeof vi.fn>;
  readonly postPrComment: ReturnType<typeof vi.fn>;
  readonly executor: GraphExecutorPort;
}

function makeDeps(opts: {
  readonly score?: number;
  readonly repoSpec?: string;
  readonly contextImpl?: () => Promise<ReviewRunContext>;
}): DepsBundle {
  const executor = makeExecutor(opts.score ?? 0.95);
  const createCheckRun = vi.fn(async () => 999);
  const updateCheckRun = vi.fn(async () => undefined);
  const loadReviewContext = vi.fn(
    opts.contextImpl ??
      (async () => makeReviewContext({ repoSpec: opts.repoSpec }))
  );
  const postPrComment = vi.fn(async () => true);

  return {
    deps: {
      executor,
      log: makeLog(),
      virtualKeyId: "vk-system",
      createCheckRun,
      updateCheckRun,
      loadReviewContext,
      postPrComment,
    },
    createCheckRun,
    updateCheckRun,
    loadReviewContext,
    postPrComment,
    executor,
  };
}

describe("handlePrReview", () => {
  it("passes, posts a comment, and uses the model declared on the rule", async () => {
    const b = makeDeps({ score: 0.95 });

    await handlePrReview(ctx, b.deps);

    expect(b.loadReviewContext).toHaveBeenCalledWith(
      ctx.owner,
      ctx.repo,
      ctx.prNumber,
      ctx.installationId
    );
    expect(b.createCheckRun).toHaveBeenCalledWith(
      ctx.owner,
      ctx.repo,
      ctx.headSha
    );
    expect(b.updateCheckRun).toHaveBeenCalledTimes(1);
    expect(b.postPrComment).toHaveBeenCalledTimes(1);

    const graphInput = (b.executor.runGraph as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as { modelRef?: { modelId?: string } };
    expect(graphInput.modelRef?.modelId).toBe("gpt-4o-mini");
  });

  it("fails when the rule score misses the threshold", async () => {
    const b = makeDeps({ score: 0.2 });

    await handlePrReview(ctx, b.deps);

    const [, , , conclusion, summary] = b.updateCheckRun.mock.calls[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(conclusion).toBe("fail");
    expect(summary).toContain("foo");
    expect(b.postPrComment).toHaveBeenCalledTimes(1);
  });

  it("silently skips a single-node repo with no gates", async () => {
    const b = makeDeps({ repoSpec: REPO_SPEC_EMPTY_GATES });

    await handlePrReview(ctx, b.deps);

    expect(b.loadReviewContext).toHaveBeenCalledTimes(1);
    expect(b.createCheckRun).not.toHaveBeenCalled();
    expect(b.updateCheckRun).not.toHaveBeenCalled();
    expect(b.postPrComment).not.toHaveBeenCalled();
    expect(b.executor.runGraph).not.toHaveBeenCalled();
  });

  it("silently skips an unrecognized-scope repo with no gates", async () => {
    const b = makeDeps({
      contextImpl: async () =>
        makeReviewContext({
          repoSpec: REPO_SPEC_EMPTY_GATES,
          owningNode: { kind: "miss" },
        }),
    });

    await handlePrReview(ctx, b.deps);

    expect(b.loadReviewContext).toHaveBeenCalledTimes(1);
    expect(b.createCheckRun).not.toHaveBeenCalled();
    expect(b.updateCheckRun).not.toHaveBeenCalled();
    expect(b.postPrComment).not.toHaveBeenCalled();
    expect(b.executor.runGraph).not.toHaveBeenCalled();
  });

  it("posts an unrecognized-scope diagnostic only when review gates are enabled", async () => {
    const b = makeDeps({
      contextImpl: async () =>
        makeReviewContext({
          repoSpec: REPO_SPEC_WITH_AI_RULE,
          owningNode: { kind: "miss" },
        }),
    });

    await handlePrReview(ctx, b.deps);

    expect(b.createCheckRun).toHaveBeenCalledWith(
      ctx.owner,
      ctx.repo,
      ctx.headSha
    );
    expect(b.updateCheckRun).toHaveBeenCalledTimes(1);
    expect(b.postPrComment).toHaveBeenCalledTimes(1);
    const [, , , , body] = b.postPrComment.mock.calls[0] as [
      string,
      string,
      number,
      string,
      string,
    ];
    expect(body).toContain("No recognizable scope");
    expect(b.executor.runGraph).not.toHaveBeenCalled();
  });

  it("does not create a check run when context loading fails", async () => {
    const b = makeDeps({
      contextImpl: () => {
        throw new Error("context-fetch-boom");
      },
    });

    await handlePrReview(ctx, b.deps);

    expect(b.createCheckRun).not.toHaveBeenCalled();
    expect(b.updateCheckRun).not.toHaveBeenCalled();
    expect(b.postPrComment).not.toHaveBeenCalled();
    expect(b.executor.runGraph).not.toHaveBeenCalled();
  });
});
