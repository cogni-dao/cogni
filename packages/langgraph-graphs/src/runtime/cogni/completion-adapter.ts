// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/runtime/cogni/completion-adapter`
 * Purpose: BaseChatModel adapter that routes LLM calls through Cogni's ALS-provided CompletionFn.
 * Scope: Enables billing/streaming integration via executeCompletionUnit pattern. Does not call LLM providers directly.
 * Invariants:
 *   - NO_MODEL_IN_ALS (#35): Model read from config.configurable.model, never ALS
 *   - MODEL_READ_FROM_CONFIGURABLE_AT_RUNNABLE_BOUNDARY (#37): Model resolved at invoke or bound by the per-run host
 *   - NO_DIRECT_MODEL_CALLS: All LLM calls go through ALS-provided CompletionFn
 *   - NO_AWAIT_IN_TOKEN_PATH: tokenSink.push() is synchronous
 *   - THROWS_AI_EXECUTION_ERROR: On completion failure, throws AiExecutionError with structured code
 *   - THROWS_FAST_IF_MISSING: Throws immediately if ALS context or model missing
 * Side-effects: none (effects via ALS-injected deps)
 * Links: LANGGRAPH_AI.md, ERROR_HANDLING_ARCHITECTURE.md, GRAPH_EXECUTION.md
 * @public
 */

import {
  type AiEvent,
  AiExecutionError,
  isAiExecutionErrorCode,
} from "@cogni/ai-core";
import type {
  BaseLanguageModelInput,
  StructuredOutputMethodOptions,
} from "@langchain/core/language_models/base";
import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type BindToolsInput,
} from "@langchain/core/language_models/chat_models";
import type { BaseMessage } from "@langchain/core/messages";
import { AIMessageChunk, SystemMessage } from "@langchain/core/messages";
import type { ChatResult } from "@langchain/core/outputs";
import type { RunnableConfig } from "@langchain/core/runnables";
import { type Runnable, RunnableLambda } from "@langchain/core/runnables";
import { convertToOpenAITool } from "@langchain/core/utils/function_calling";
import type { SerializableSchema } from "@langchain/core/utils/standard_schema";
import type { InteropZodType } from "@langchain/core/utils/types";
import { fromBaseMessage, type Message } from "../core/message-converters";
import { getCogniExecContext } from "./exec-context";

/** OpenAI tool format - matches LlmToolDefinition in ports */
type OpenAIToolDef = ReturnType<typeof convertToOpenAITool>;

/**
 * Completion function signature obtained from ALS.
 * Per GRAPH_LLM_VIA_COMPLETION: graph calls this, not LLM SDK directly.
 *
 * Generic TTool allows src/ to use LlmToolDefinition while package defaults to unknown.
 */
export type CompletionFn<TTool = unknown> = (params: {
  messages: Message[];
  model: string;
  tools?: readonly TTool[];
  toolChoice?: CompletionToolChoice;
  abortSignal?: AbortSignal;
}) => {
  /** Stream of AiEvents (text_delta, usage_report) */
  stream: AsyncIterable<AiEvent>;
  /** Final result with assembled response */
  final: Promise<CompletionResult>;
};

export type CompletionToolChoice =
  | "auto"
  | "none"
  | "required"
  | { readonly type: "function"; readonly function: { readonly name: string } };

export class InvalidCompletionError extends Error {
  constructor() {
    super("empty_model_completion");
    this.name = "InvalidCompletionError";
  }
}

/**
 * Tool call in OpenAI format (matches LlmToolCall in ports).
 * Defined here to avoid src/ imports per PACKAGES_NO_SRC_IMPORTS.
 */
export interface ToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

/**
 * Result from completion function.
 */
export interface CompletionResult {
  readonly ok: boolean;
  readonly content?: string;
  /** Tool calls in OpenAI format (nested function.name/arguments) */
  readonly toolCalls?: ToolCall[];
  readonly usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  readonly finishReason?: string;
  readonly error?: string;
}

/**
 * Token sink for synchronous event pushing.
 * Per NO_AWAIT_IN_TOKEN_PATH: push() must be sync.
 */
export interface TokenSink {
  push: (event: AiEvent) => void;
}

/**
 * Extended RunnableConfig with our configurable fields.
 * Model comes from configurable per #35/#37.
 */
interface CogniCompletionConfig extends RunnableConfig {
  configurable?: {
    model?: string;
    toolIds?: readonly string[];
    [key: string]: unknown;
  };
}

/**
 * Internal config for CogniCompletionAdapter.
 * Only used by bindTools() to pass tools to new instance.
 * @internal
 */
interface CogniCompletionAdapterConfig {
  readonly boundTools?: OpenAIToolDef[];
  readonly toolChoice?: CompletionToolChoice;
  readonly model?: string;
  readonly signal?: AbortSignal;
  readonly rejectEmpty?: boolean;
}

/** A real SDK chat model; all provider work still uses the billed CompletionFn. */
export class CogniCompletionAdapter extends BaseChatModel {
  private readonly binding: CogniCompletionAdapterConfig;
  lc_namespace = ["cogni", "langgraph"];
  // Trusted harness-profile identity; the actual billed model is binding.model.
  readonly modelName = "cogni:read-only-v0";
  static lc_name(): string {
    return "CogniCompletionAdapter";
  }
  _llmType(): string {
    return "cogni_completion";
  }
  constructor(binding: CogniCompletionAdapterConfig = {}) {
    super({ disableStreaming: true });
    this.binding = binding;
  }

  /** Immutable per-invocation model/signal also cover configless SDK summaries. */
  bindRun(model: string, signal?: AbortSignal, rejectEmpty = false) {
    if (this.binding.model && this.binding.model !== model)
      throw new Error("bound_model_mismatch");
    return new CogniCompletionAdapter({
      ...this.binding,
      model,
      ...(signal ? { signal } : {}),
      rejectEmpty,
    });
  }

  override async invoke(
    input: BaseLanguageModelInput,
    config?: CogniCompletionConfig
  ): Promise<AIMessageChunk> {
    const model = config?.configurable?.model ?? this.binding.model;
    if (!model)
      throw new Error(
        "[CogniCompletionAdapter] config.configurable.model is required."
      );
    if (this.binding.model && model !== this.binding.model)
      throw new Error("bound_model_mismatch");
    if (!this.binding.model)
      return this.bindRun(model, config?.signal).invoke(input, config);
    return super.invoke(input, config);
  }

  async _generate(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions
  ): Promise<ChatResult> {
    const model = this.binding.model;
    if (!model) throw new Error("bound_model_required");
    const { completionFn, tokenSink } = getCogniExecContext();
    const { stream, final } = completionFn({
      messages: messages.map(fromBaseMessage),
      model,
      ...(this.binding.signal || options.signal
        ? { abortSignal: this.binding.signal ?? options.signal }
        : {}),
      ...(this.binding.boundTools?.length
        ? { tools: this.binding.boundTools }
        : {}),
      ...(this.binding.toolChoice
        ? { toolChoice: this.binding.toolChoice }
        : {}),
    });
    const guarded = final.catch(() => undefined);
    try {
      for await (const event of stream) tokenSink.push(event);
    } finally {
      await guarded;
    }
    const result = await final;
    if (!result.ok) {
      const code =
        result.error && isAiExecutionErrorCode(result.error)
          ? result.error
          : "internal";
      throw new AiExecutionError(code, `Completion failed: ${code}`);
    }
    // Usage has already traversed the normal sink before this retryable classification.
    if (
      this.binding.rejectEmpty &&
      !result.content?.trim() &&
      !result.toolCalls?.length
    )
      throw new InvalidCompletionError();
    const message = new AIMessageChunk({
      content: result.content ?? "",
      response_metadata: { finish_reason: result.finishReason },
      ...(result.usage
        ? {
            usage_metadata: {
              input_tokens: result.usage.promptTokens,
              output_tokens: result.usage.completionTokens,
              total_tokens:
                result.usage.promptTokens + result.usage.completionTokens,
            },
          }
        : {}),
      tool_calls: result.toolCalls?.map((tc, i) => {
        if (!tc.function?.name)
          throw new Error(`missing toolCall function.name at index ${i}`);
        return {
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments || "{}") as Record<
            string,
            unknown
          >,
          type: "tool_call" as const,
        };
      }),
    });
    return {
      generations: [
        {
          text: typeof message.content === "string" ? message.content : "",
          message,
        },
      ],
    };
  }

  /**
   * Return a Runnable that invokes the LLM and parses JSON structured output.
   *
   * Implements the BaseChatModel.withStructuredOutput() contract so LangGraph's
   * `createReactAgent({ responseFormat })` works with our adapter.
   *
   * LangGraph calls this in the `generate_structured_response` node:
   *   model.withStructuredOutput(schema, options).invoke(messages, config)
   *
   * The caller provides the Zod schema — this method just instructs JSON mode
   * and validates the response against it.
   *
   * @param schema - Zod schema or JSON Schema object
   * @param _options - StructuredOutputMethodOptions (name, method, includeRaw, strict)
   */
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    schema:
      | SerializableSchema<RunOutput>
      | InteropZodType<RunOutput>
      | Record<string, unknown>,
    options?: StructuredOutputMethodOptions<false>
  ): Runnable<BaseLanguageModelInput, RunOutput>;
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    schema:
      | SerializableSchema<RunOutput>
      | InteropZodType<RunOutput>
      | Record<string, unknown>,
    options?: StructuredOutputMethodOptions<true>
  ): Runnable<BaseLanguageModelInput, { raw: BaseMessage; parsed: RunOutput }>;
  override withStructuredOutput<
    RunOutput extends Record<string, unknown> = Record<string, unknown>,
  >(
    schema:
      | SerializableSchema<RunOutput>
      | InteropZodType<RunOutput>
      | Record<string, unknown>,
    options?: StructuredOutputMethodOptions<boolean>
  ): Runnable<
    BaseLanguageModelInput,
    RunOutput | { raw: BaseMessage; parsed: RunOutput }
  > {
    return RunnableLambda.from(
      async (input: BaseLanguageModelInput, config?: RunnableConfig) => {
        const messages =
          BaseChatModel._convertInputToPromptValue(input).toChatMessages();
        // Prepend system instruction for JSON output
        const augmented = [
          new SystemMessage({
            content:
              "You must respond with valid JSON only. " +
              "No markdown code fences, no extra text outside the JSON object.",
          }),
          ...messages,
        ];

        const aiMessage = await this.invoke(augmented, config);

        // Extract text content from AIMessage
        const text =
          typeof aiMessage.content === "string"
            ? aiMessage.content
            : Array.isArray(aiMessage.content)
              ? aiMessage.content
                  .filter(
                    (p): p is { type: "text"; text: string } =>
                      typeof p === "object" &&
                      p !== null &&
                      "type" in p &&
                      p.type === "text"
                  )
                  .map((p) => p.text)
                  .join("")
              : "";

        // Strip markdown code fences if model wraps JSON in them
        // Trim first so ^ and $ anchors match even with leading/trailing whitespace
        const cleaned = text
          .trim()
          .replace(/^```(?:json)?\n?/i, "")
          .replace(/\n?```$/, "")
          .trim();

        let parsed: RunOutput;
        try {
          parsed = JSON.parse(cleaned) as RunOutput;
        } catch {
          throw new Error(
            `[CogniCompletionAdapter.withStructuredOutput] LLM returned invalid JSON: ${cleaned.slice(0, 200)}`
          );
        }

        // Validate with Zod if schema has .parse()
        if ("parse" in schema && typeof schema.parse === "function") {
          parsed = schema.parse(parsed) as RunOutput;
        }

        if (
          "~standard" in schema &&
          schema["~standard"] &&
          typeof schema["~standard"] === "object" &&
          "validate" in schema["~standard"] &&
          typeof schema["~standard"].validate === "function"
        ) {
          const validation = await schema["~standard"].validate(parsed);
          if (validation.issues)
            throw new Error("structured_output_schema_invalid");
          parsed = validation.value as RunOutput;
        }
        return options?.includeRaw ? { raw: aiMessage, parsed } : parsed;
      }
    );
  }

  /**
   * Bind tools to this adapter instance.
   * Converts LangChain tools to OpenAI format and returns a new instance.
   *
   * Per #35/#37: model is NOT captured here — always read from configurable in invoke().
   */
  override bindTools(
    tools: BindToolsInput[],
    kwargs?: Partial<BaseChatModelCallOptions>
  ): CogniCompletionAdapter {
    const choice = kwargs?.tool_choice;
    let toolChoice: CompletionToolChoice | undefined;
    if (choice === "any" || choice === "required") toolChoice = "required";
    else if (choice === "auto" || choice === "none") toolChoice = choice;
    else if (typeof choice === "string")
      toolChoice = { type: "function", function: { name: choice } };
    else if (choice && typeof choice === "object" && "function" in choice) {
      const fn = choice.function;
      if (
        fn &&
        typeof fn === "object" &&
        "name" in fn &&
        typeof fn.name === "string"
      )
        toolChoice = { type: "function", function: { name: fn.name } };
      else throw new Error("unsupported_tool_choice");
    } else if (choice !== undefined) throw new Error("unsupported_tool_choice");
    return new CogniCompletionAdapter({
      ...this.binding,
      boundTools: tools.map((tool) => convertToOpenAITool(tool)),
      ...(toolChoice ? { toolChoice } : {}),
    });
  }
}
