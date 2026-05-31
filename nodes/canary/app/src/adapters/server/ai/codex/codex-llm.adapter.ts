// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/codex/codex-llm.adapter`
 * Purpose: LlmService implementation using Codex SDK subprocess for ChatGPT subscription auth.
 * Scope: Implements LlmService by spawning `codex exec` per call. Receives pre-resolved credentials
 *   from ConnectionBrokerPort. Writes temp auth.json, spawns subprocess, streams JSONL events as
 *   ChatDeltaEvents, cleans up. Graph logic (nodes, tools, state) stays in LangGraph — only the
 *   LLM call routes through ChatGPT.
 * Invariants:
 *   - LLM_SERVICE_ADAPTER: Implements LlmService, not GraphExecutorPort. Swaps the model backend, not the graph executor.
 *   - SUBPROCESS_PER_REQUEST: Each LLM call spawns an isolated `codex exec` subprocess.
 *   - TOKENS_NEVER_LOGGED: Credential values never appear in logs.
 *   - TEMP_AUTH_CLEANUP: Temp auth dir always cleaned up in finally block.
 *   - CODEX_ENV_SCOPED: Codex subprocess receives only whitelisted env vars (bug.0232).
 *   - NO_SILENT_TOOL_DROP: Tools received but not usable via params → WARN log with INVARIANT_DEVIATION prefix (bug.0232).
 *   - INVARIANT_DEVIATION: TOOLS_VIA_TOOLRUNNER — Codex calls MCP tools directly via config.toml,
 *     bypassing toolRunner.exec(). Mitigated by server-level scoping + $0 billing (user-funded).
 * Side-effects: IO (spawns subprocess, writes temp auth.json + config.toml, cleans up)
 * Links: docs/research/openai-oauth-byo-ai.md, bug.0232
 * @internal
 */

import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message } from "@cogni/ai-core";
import type { Logger } from "pino";
import { CODEX_MODEL_LABELS } from "@/adapters/server/ai/providers/codex.provider";
import type {
  ChatDeltaEvent,
  CompletionStreamParams,
  LlmCompletionResult,
  LlmService,
  ResolvedConnection,
} from "@/ports";
import { makeLogger } from "@/shared/observability";
import {
  buildScopedEnv,
  type CodexMcpConfig,
  generateConfigToml,
} from "./codex-mcp-config";

const log = makeLogger({ component: "CodexLlmAdapter" });

/**
 * LlmService backed by Codex SDK subprocess.
 *
 * Crawl-phase adapter: uses local ~/.codex/auth.json via resolved credentials
 * from ConnectionBrokerPort. Each LLM call spawns `codex exec` (~2s cold start).
 *
 * This keeps all LangGraph graph logic intact — nodes, tools, state machines.
 * Only the LLM completion call routes through ChatGPT instead of LiteLLM/OpenRouter.
 *
 * KNOWN_DEVIATION: ALL_SERVERS_VISIBLE — mcpConfig contains ALL configured MCP servers,
 * not filtered by the graph's mcpServerIds. The ModelProviderPort.createLlmService()
 * is called before graph execution (in bootstrap/factory), before mcpServerIds are known.
 * Per-graph filtering would require threading catalog data through the port interface.
 * Acceptable because: Codex is user-funded ($0 platform cost), system prompt guides usage,
 * and only 2 servers exist (playwright, grafana). Revisit when ToolHive (Phase 3) lands.
 */
export class CodexLlmAdapter implements LlmService {
  constructor(
    private readonly connection: ResolvedConnection,
    private readonly mcpConfig?: CodexMcpConfig
  ) {}

  async completion(
    params: Parameters<LlmService["completion"]>[0]
  ): ReturnType<LlmService["completion"]> {
    const { stream, final } = await this.completionStream({
      ...params,
    });
    // Drain stream, collect text
    for await (const _event of stream) {
      // just drain
    }
    return final;
  }

  async completionStream(params: CompletionStreamParams): Promise<{
    stream: AsyncIterable<ChatDeltaEvent>;
    final: Promise<LlmCompletionResult>;
  }> {
    const connection = this.connection;
    const callLog = log.child({ model: params.model });

    // NO_SILENT_TOOL_DROP: Log when tools are passed but cannot be used via params.tools.
    // Codex uses MCP tools natively via config.toml, NOT via OpenAI function-calling format.
    if (params.tools && params.tools.length > 0) {
      callLog.warn(
        {
          toolCount: params.tools.length,
          mcpServerCount: this.mcpConfig
            ? Object.keys(this.mcpConfig).length
            : 0,
        },
        "INVARIANT_DEVIATION: TOOLS_VIA_TOOLRUNNER — Codex adapter received tools via params.tools " +
          "but cannot use OpenAI function-calling format. Tools stripped from LLM request. " +
          "MCP tools available via config.toml."
      );
    }

    type Deferred<T> = {
      promise: Promise<T>;
      resolve: (v: T) => void;
      reject: (e: unknown) => void;
    };
    function defer<T>(): Deferred<T> {
      let resolve!: (v: T) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    }

    const deferred = defer<LlmCompletionResult>();

    const stream = runCodexExec({
      messages: params.messages,
      ...(params.model ? { model: params.model } : {}),
      connection,
      ...(this.mcpConfig ? { mcpConfig: this.mcpConfig } : {}),
      log: callLog,
      onResult: deferred.resolve,
      onError: deferred.reject,
      ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    });

    return { stream, final: deferred.promise };
  }
}

/**
 * Spawn codex exec subprocess with temp auth, stream ChatDeltaEvents.
 */
async function* runCodexExec(params: {
  messages: Message[];
  model?: string;
  connection: ResolvedConnection;
  mcpConfig?: CodexMcpConfig;
  log: Logger;
  onResult: (r: LlmCompletionResult) => void;
  onError: (e: unknown) => void;
  abortSignal?: AbortSignal;
}): AsyncIterable<ChatDeltaEvent> {
  const {
    messages,
    model,
    connection,
    mcpConfig,
    log: callLog,
    onResult,
    onError,
  } = params;
  const startMs = Date.now();

  // Create isolated temp dir for this call's auth
  const tempDir = join(tmpdir(), `cogni-codex-${randomUUID()}`);
  const codexDir = join(tempDir, ".codex");

  try {
    // Write temp auth.json matching Codex CLI's expected format
    await mkdir(codexDir, { recursive: true });
    await writeFile(
      join(codexDir, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: connection.credentials.idToken ?? "",
          access_token: connection.credentials.accessToken,
          refresh_token: connection.credentials.refreshToken ?? "",
          account_id: connection.credentials.accountId ?? "",
        },
        last_refresh: new Date().toISOString(),
      }),
      { mode: 0o600 }
    );

    // Write config.toml for Codex-native MCP server access (bug.0232).
    // INVARIANT_DEVIATION: TOOLS_VIA_TOOLRUNNER — Codex calls MCP tools directly
    // via its own agent loop, bypassing toolRunner.exec().
    const configToml = mcpConfig ? generateConfigToml(mcpConfig) : undefined;
    if (configToml && mcpConfig) {
      await writeFile(join(codexDir, "config.toml"), configToml, {
        mode: 0o600,
      });
      callLog.debug(
        { mcpServerCount: Object.keys(mcpConfig).length },
        "Wrote Codex config.toml with MCP servers"
      );
    }

    // Dynamic import to avoid module-scope subprocess spawn
    const { Codex } = await import("@openai/codex-sdk");
    // SDK's findCodexPath() resolves the native binary via createRequire(import.meta.url).
    // @openai/codex-sdk, @openai/codex, and @openai/codex-linux-x64 are in
    // serverExternalPackages so standalone doesn't bundle/prune them.
    // Dev: resolved from repo node_modules. Docker: resolved from global pnpm install.

    // CODEX_ENV_SCOPED: Only whitelisted env vars + MCP bearer token vars.
    // Prevents leaking DATABASE_URL, LITELLM_MASTER_KEY, AUTH_SECRET, etc.
    const { env: currentEnv } = await import("node:process");
    const envRecord = buildScopedEnv(currentEnv, mcpConfig);
    envRecord.HOME = tempDir;

    const codex = new Codex({
      env: envRecord,
    });

    const thread = codex.startThread({
      ...(model ? { model } : {}),
      sandboxMode: "read-only",
      approvalPolicy: "never",
      skipGitRepoCheck: true,
    });

    // Format full conversation for codex exec
    const prompt = formatMessagesAsPrompt(messages);

    callLog.info(
      { messageCount: messages.length },
      "Codex LLM call started via codex exec"
    );

    const { events } = await thread.runStreamed(prompt);

    let fullText = "";
    let itemText = "";
    let usage: { promptTokens: number; completionTokens: number } | undefined;

    for await (const event of events) {
      switch (event.type) {
        case "item.started": {
          if (event.item.type === "agent_message") {
            // Reset per-item tracking — each agent_message starts fresh
            itemText = "";
          }
          break;
        }
        case "item.updated":
        case "item.completed": {
          if (event.item.type === "agent_message") {
            const newText = event.item.text;
            if (newText.length > itemText.length) {
              const delta = newText.slice(itemText.length);
              itemText = newText;
              fullText += delta;
              yield { type: "text_delta", delta } as ChatDeltaEvent;
            }
          }
          break;
        }
        case "turn.completed": {
          usage = {
            promptTokens: event.usage.input_tokens,
            completionTokens: event.usage.output_tokens,
          };
          break;
        }
        case "turn.failed": {
          callLog.error(
            { error: event.error.message, durationMs: Date.now() - startMs },
            "Codex turn failed"
          );
          // Settle deferred BEFORE yielding done — consumer breaks loop on done,
          // which calls generator.return() and skips any code after the last yield.
          onError(new Error(`Codex turn failed: ${event.error.message}`));
          yield { type: "error", error: event.error.message } as ChatDeltaEvent;
          yield { type: "done" } as ChatDeltaEvent;
          return;
        }
        case "error": {
          callLog.error(
            { error: event.message, durationMs: Date.now() - startMs },
            "Codex stream error"
          );
          // Settle deferred BEFORE yielding done (see turn.failed comment).
          onError(new Error(`Codex error: ${event.message}`));
          yield { type: "error", error: event.message } as ChatDeltaEvent;
          yield { type: "done" } as ChatDeltaEvent;
          return;
        }
        default:
          break;
      }
    }

    const durationMs = Date.now() - startMs;
    callLog.info(
      {
        durationMs,
        textLength: fullText.length,
        promptTokens: usage?.promptTokens,
        completionTokens: usage?.completionTokens,
      },
      "Codex LLM call complete"
    );

    // Resolve final BEFORE yielding done — the consumer awaits final after
    // seeing done, so the deferred must be resolved before the generator pauses.
    onResult({
      message: { role: "assistant", content: fullText },
      ...(usage
        ? {
            usage: {
              promptTokens: usage.promptTokens,
              completionTokens: usage.completionTokens,
              totalTokens: usage.promptTokens + usage.completionTokens,
            },
          }
        : {}),
      finishReason: "stop",
      resolvedProvider: "openai-chatgpt",
      ...(model ? { resolvedModel: model } : {}),
      ...((): Record<string, never> | { resolvedDisplayName: string } => {
        const label = model ? CODEX_MODEL_LABELS.get(model) : undefined;
        return label ? { resolvedDisplayName: label } : {};
      })(),
    });

    yield { type: "done" } as ChatDeltaEvent;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    callLog.error(
      { error: message, durationMs: Date.now() - startMs },
      "Codex LLM call failed"
    );
    // Settle deferred BEFORE yielding done (see turn.failed comment).
    onError(error);
    yield { type: "error", error: message } as ChatDeltaEvent;
    yield { type: "done" } as ChatDeltaEvent;
  } finally {
    rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Format full message history into a single prompt string.
 * codex exec takes one string per turn — serialize the entire
 * conversation so the model has full multi-turn context.
 */
function formatMessagesAsPrompt(messages: Message[]): string {
  const parts: string[] = [];
  const systemParts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
    } else if (msg.role === "user") {
      parts.push(`User: ${msg.content}`);
    } else if (msg.role === "assistant") {
      parts.push(`Assistant: ${msg.content}`);
    } else if (msg.role === "tool") {
      parts.push(`Tool result: ${msg.content}`);
    }
  }

  const system = systemParts.length > 0 ? `${systemParts.join("\n")}\n\n` : "";
  return system + parts.join("\n\n");
}
