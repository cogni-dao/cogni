// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox/sandbox-graph.provider`
 * Purpose: GraphExecutorPort implementation that executes agents in sandboxed containers.
 * Scope: Routes sandbox:* graphIds through SandboxRunnerAdapter. Does not implement agent logic.
 * Invariants:
 *   - Per SANDBOXED_AGENTS.md P0.75: Agent runs in sandbox via graph execution pipeline
 *   - Per UNIFIED_GRAPH_EXECUTOR: Registered in NamespaceGraphRouter like any provider
 *   - Per SECRETS_HOST_ONLY: Only messages + model passed to sandbox, never credentials
 *   - Per BILLING_INDEPENDENT_OF_CLIENT: ephemeral emits usage_report for RunEventRelay billing
 * Side-effects: IO (creates tmp workspace, runs Docker containers via SandboxRunnerPort)
 * Links: docs/spec/sandboxed-agents.md, sandbox-runner.adapter.ts
 * @internal
 */

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiEvent, UsageFact } from "@cogni/ai-core";
import type { Logger } from "pino";
import { getExecutionScope } from "@/adapters/server/ai/execution-scope";
import type {
  AiExecutionErrorCode,
  ExecutionContext,
  GraphExecutorPort,
  GraphFinal,
  GraphRunRequest,
  GraphRunResult,
  SandboxProgramContract,
  SandboxRunnerPort,
  SandboxRunResult,
} from "@/ports";
import { EVENT_NAMES, makeLogger } from "@/shared/observability";

/** Provider ID for sandbox agent execution */
export const SANDBOX_PROVIDER_ID = "sandbox" as const;

/**
 * Workspace setup context passed to agent-specific workspace preparation functions.
 */
interface WorkspaceSetupContext {
  readonly workspaceDir: string;
  readonly cogniDir: string;
  readonly messages: readonly unknown[];
  readonly model: string;
  readonly runId: string;
}

/** Sandbox agent definition with image, limits, and workspace setup */
interface SandboxAgentEntry {
  readonly name: string;
  readonly description: string;
  /** Docker image to use for this agent */
  readonly image: string;
  /** Command to execute in the sandbox container */
  readonly argv: readonly string[];
  /** Resource limits for the container */
  readonly limits: {
    readonly maxRuntimeSec: number;
    readonly maxMemoryMb: number;
  };
  /**
   * Prepare workspace files before container start.
   * Default (undefined): writes messages.json to .cogni/
   * Custom: writes agent-specific config files.
   */
  readonly setupWorkspace?: (ctx: WorkspaceSetupContext) => void;
  /**
   * Additional env vars to pass via llmProxy.env (merged with COGNI_MODEL).
   */
  readonly extraEnv?: (ctx: WorkspaceSetupContext) => Record<string, string>;
}

/**
 * Registry of known sandbox agents.
 * Each entry fully describes image, limits, argv, and workspace setup.
 */
const SANDBOX_AGENTS: Record<string, SandboxAgentEntry> = {
  agent: {
    name: "Sandbox Agent",
    description:
      "LLM agent running in isolated container (network=none, LLM via proxy)",
    image: "cogni-sandbox-runtime:latest",
    argv: ["node", "/agent/run.mjs"],
    limits: { maxRuntimeSec: 120, maxMemoryMb: 512 },
  },
};

/**
 * GraphExecutorPort that executes agents in sandboxed Docker containers.
 *
 * Per SANDBOXED_AGENTS.md P0.75: integrates sandbox execution into the
 * standard chat pipeline so users can select "sandbox:agent" in the UI.
 *
 * Flow:
 * 1. Write messages to workspace as JSON
 * 2. Run agent in sandbox via SandboxRunnerPort.runOnce()
 * 3. Agent reads messages, calls LLM via OPENAI_API_BASE, prints response
 * 4. Collect stdout → emit as text_delta AiEvents
 * 5. Emit usage_report for billing
 * 6. Return GraphFinal
 */
export class SandboxGraphProvider implements GraphExecutorPort {
  readonly providerId = SANDBOX_PROVIDER_ID;
  private readonly log: Logger;

  constructor(private readonly runner: SandboxRunnerPort) {
    this.log = makeLogger({ component: "SandboxGraphProvider" });
    this.log.debug(
      { agents: Object.keys(SANDBOX_AGENTS) },
      "SandboxGraphProvider initialized"
    );
  }

  runGraph(req: GraphRunRequest, _ctx?: ExecutionContext): GraphRunResult {
    const { runId, graphId } = req;
    const requestId = _ctx?.requestId ?? req.runId;

    const agentName = graphId.slice(this.providerId.length + 1);
    const agent = SANDBOX_AGENTS[agentName];
    if (!agent) {
      this.log.error({ runId, graphId, agentName }, "Unknown sandbox agent");
      return this.createErrorResult(runId, requestId, "not_found");
    }

    this.log.info(
      {
        event: EVENT_NAMES.SANDBOX_EXECUTION_STARTED,
        runId,
        requestId,
        agentName,
        executionMode: "ephemeral",
        model: req.modelRef.modelId,
        messageCount: req.messages.length,
      },
      EVENT_NAMES.SANDBOX_EXECUTION_STARTED
    );

    return this.createContainerExecution(req, agent, requestId);
  }

  /**
   * Create the async stream + final promise for an ephemeral container execution.
   * Pattern matches LangGraphInProcProvider: runGraph returns synchronously,
   * execution happens when the stream is consumed.
   */
  private createContainerExecution(
    req: GraphRunRequest,
    agent: SandboxAgentEntry,
    requestId: string
  ): GraphRunResult {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const state = {
      resolve: null as null | ((value: GraphFinal) => void),
    };
    const final = new Promise<GraphFinal>((resolve) => {
      state.resolve = resolve;
    });

    // Capture ALS scope synchronously at runGraph() call time — before entering
    // the async generator. ALS context may not propagate through generator iteration
    // in production builds (Node async_hooks + webpack boundary issue).
    const scope = getExecutionScope();
    const stream = (async function* (): AsyncIterable<AiEvent> {
      const { runId, messages, modelRef, graphId } = req;
      const model = modelRef.modelId;
      const attempt = 0; // P0_ATTEMPT_FREEZE
      const execStartTime = Date.now();

      // Create isolated workspace with messages file
      const workspaceDir = mkdtempSync(join(tmpdir(), `sandbox-${runId}-`));
      const cogniDir = join(workspaceDir, ".cogni");
      mkdirSync(cogniDir, { recursive: true });

      // Symlink-safe write: verify resolved path stays inside workspace
      // Prevents symlink escape if workspace is somehow tampered before write
      const realWorkspace = realpathSync(workspaceDir);
      const realCogniDir = realpathSync(cogniDir);
      if (!realCogniDir.startsWith(realWorkspace)) {
        throw new Error(
          `Symlink escape detected: ${realCogniDir} outside ${realWorkspace}`
        );
      }

      // Agent-specific workspace setup (or default: write messages.json)
      const setupCtx: WorkspaceSetupContext = {
        workspaceDir: realWorkspace,
        cogniDir: realCogniDir,
        messages,
        model,
        runId,
      };
      if (agent.setupWorkspace) {
        agent.setupWorkspace(setupCtx);
      } else {
        // Default: write messages for agent to read (per P0.75 I/O protocol)
        writeFileSync(
          join(realCogniDir, "messages.json"),
          JSON.stringify(messages, null, 2)
        );
      }

      self.log.debug(
        { runId, workspaceDir: realWorkspace, agent: agent.name },
        "Workspace prepared"
      );

      try {
        // Build env vars: COGNI_MODEL + agent-specific extras
        const proxyEnv: Record<string, string> = { COGNI_MODEL: model };
        if (agent.extraEnv) {
          Object.assign(proxyEnv, agent.extraEnv(setupCtx));
        }

        // Run agent in sandbox with LLM proxy enabled
        const result = await self.runner.runOnce({
          runId,
          workspacePath: realWorkspace,
          image: agent.image,
          argv: [...agent.argv],
          limits: agent.limits,
          // Mount git-synced repo (read-only mirror, UID 1001 aligned)
          volumes: [
            { volume: "repo_data", containerPath: "/repo", readOnly: true },
          ],
          llmProxy: {
            enabled: true,
            attempt,
            billingAccountId: scope.billing.billingAccountId,
            env: proxyEnv,
          },
        });

        // Parse SandboxProgramContract envelope from stdout.
        const envelope = self.parseEnvelope(runId, result);

        if (!result.ok || envelope.meta.error) {
          const errInfo = envelope.meta.error;
          self.log.error(
            {
              event: EVENT_NAMES.SANDBOX_EXECUTION_COMPLETE,
              runId,
              requestId,
              executionMode: "ephemeral",
              outcome: "error",
              durationMs: Date.now() - execStartTime,
              model,
              errorCode: result.errorCode ?? errInfo?.code,
              exitCode: result.exitCode,
            },
            EVENT_NAMES.SANDBOX_EXECUTION_COMPLETE
          );
          yield { type: "error", error: "internal" as AiExecutionErrorCode };
          yield { type: "done" };
          if (state.resolve) {
            state.resolve({
              ok: false,
              runId,
              requestId,
              error: "internal",
            });
          }
          return;
        }

        const content = envelope.payloads[0]?.text ?? "";

        // Emit response as text_delta
        if (content) {
          yield { type: "text_delta", delta: content };
        }

        // Emit usage_report for billing — driven by proxy audit log, not agent stdout.
        // Mirrors inproc: host-side infrastructure captures x-litellm-call-id + x-litellm-response-cost.
        // One usage_report per LLM call (works for single-call and multi-call agents).
        const billingEntries = result.proxyBillingEntries ?? [];
        if (billingEntries.length > 0) {
          for (const entry of billingEntries) {
            const usageFact: UsageFact = {
              runId,
              attempt,
              source: "litellm",
              executorType: "sandbox",
              graphId,
              model,
              usageUnitId: entry.litellmCallId,
              ...(entry.costUsd !== undefined && { costUsd: entry.costUsd }),
            };
            yield { type: "usage_report", fact: usageFact };
          }
        } else {
          // No billing entries from proxy — LLM calls may not have happened or log parse failed
          self.log.error(
            { runId, model },
            "CRITICAL: No billing entries from proxy audit log - billing incomplete, failing run"
          );
          throw new Error(
            "Billing failed: no proxy billing entries (x-litellm-call-id not found in audit log)"
          );
        }

        // Emit assistant_final for history persistence
        yield { type: "assistant_final", content: content || "" };

        self.log.info(
          {
            event: EVENT_NAMES.SANDBOX_EXECUTION_COMPLETE,
            runId,
            requestId,
            executionMode: "ephemeral",
            outcome: "success",
            durationMs: Date.now() - execStartTime,
            billingEntryCount: billingEntries.length,
            model,
          },
          EVENT_NAMES.SANDBOX_EXECUTION_COMPLETE
        );

        yield { type: "done" };

        if (state.resolve) {
          state.resolve({
            ok: true,
            runId,
            requestId,
            finishReason: "stop",
            ...(content ? { content } : {}),
          });
        }
      } catch (err) {
        self.log.error(
          {
            event: EVENT_NAMES.SANDBOX_EXECUTION_COMPLETE,
            runId,
            requestId,
            executionMode: "ephemeral",
            outcome: "error",
            durationMs: Date.now() - execStartTime,
            model,
            errorMessage: err instanceof Error ? err.message : String(err),
          },
          EVENT_NAMES.SANDBOX_EXECUTION_COMPLETE
        );
        yield { type: "error", error: "internal" as AiExecutionErrorCode };
        yield { type: "done" };
        if (state.resolve) {
          state.resolve({
            ok: false,
            runId,
            requestId,
            error: "internal",
          });
        }
      } finally {
        // Cleanup workspace (proxy audit log already collected by runner)
        try {
          rmSync(realWorkspace, { recursive: true, force: true });
        } catch {
          // Best-effort cleanup
        }
      }
    })();

    return { stream, final };
  }

  /**
   * Parse SandboxProgramContract JSON from stdout.
   * Tolerant: if stdout isn't valid JSON, returns an error envelope
   * so the caller handles it uniformly.
   */
  private parseEnvelope(
    runId: string,
    result: SandboxRunResult
  ): SandboxProgramContract {
    const raw = result.stdout.trim();
    try {
      return JSON.parse(raw) as SandboxProgramContract;
    } catch {
      this.log.warn(
        { runId, stdoutLen: raw.length, stdoutHead: raw.slice(0, 200) },
        "Sandbox stdout is not valid SandboxProgramContract JSON"
      );
      return {
        payloads: [],
        meta: {
          durationMs: 0,
          error: { code: "parse_error", message: "stdout is not valid JSON" },
        },
      };
    }
  }

  /**
   * Create error result for invalid requests (same pattern as LangGraphInProcProvider).
   */
  private createErrorResult(
    runId: string,
    requestId: string,
    code: AiExecutionErrorCode = "internal"
  ): GraphRunResult {
    const errorStream = (async function* () {
      yield { type: "error" as const, error: code };
      yield { type: "done" as const };
    })();

    return {
      stream: errorStream,
      final: Promise.resolve({
        ok: false as const,
        runId,
        requestId,
        error: code,
      }),
    };
  }
}
