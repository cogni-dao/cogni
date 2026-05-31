// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/providers/codex.provider`
 * Purpose: ModelProviderPort implementation for BYO ChatGPT/Codex models.
 * Scope: Lists hardcoded ChatGPT model IDs, creates CodexLlmAdapter from resolved connection + optional MCP config.
 *   All Codex models are free (use user's own ChatGPT subscription, no platform credits).
 * Invariants:
 *   - requiresPlatformCredits always false (user-funded)
 *   - requiresConnection always true (needs OAuth credentials)
 * Side-effects: none (adapter creation is lazy)
 * Links: docs/spec/multi-provider-llm.md, docs/research/openai-oauth-byo-ai.md
 * @internal
 */

import type { ModelRef } from "@cogni/ai-core";
import type {
  LlmService,
  ModelOption,
  ModelProviderPort,
  ProviderContext,
  ResolvedConnection,
} from "@/ports";
import { CodexLlmAdapter } from "../codex/codex-llm.adapter";
import type { CodexMcpConfig } from "../codex/codex-mcp-config";

/**
 * Known ChatGPT subscription model IDs available via Codex transport.
 * These are hardcoded because they come from the user's ChatGPT subscription,
 * not from a discovery API.
 */
const CODEX_MODELS = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
  { id: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { id: "gpt-5.1-codex", label: "GPT-5.1 Codex" },
  { id: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
  { id: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
] as const;

/** Map of Codex model ID → display label. Used by the adapter to set resolvedDisplayName. */
export const CODEX_MODEL_LABELS = new Map<string, string>(
  CODEX_MODELS.map((m) => [m.id, m.label])
);

/**
 * Codex model provider — backed by user's ChatGPT subscription via Codex SDK.
 * Implements ModelProviderPort for the "codex" providerKey.
 */
export class CodexModelProvider implements ModelProviderPort {
  readonly providerKey = "codex" as const;
  readonly usageSource = "codex" as const;
  readonly requiresConnection = true;

  constructor(private readonly mcpConfig?: CodexMcpConfig) {}

  async listModels(_ctx: ProviderContext): Promise<ModelOption[]> {
    // TODO: Only return models when user has an active openai-chatgpt connection.
    // For now, always return the full list — the UI handles connection gating.
    return CODEX_MODELS.map((m) => ({
      ref: { providerKey: this.providerKey, modelId: m.id },
      label: m.label,
      requiresPlatformCredits: false,
      providerLabel: "ChatGPT",
      capabilities: {
        streaming: false,
        tools: false,
        structuredOutput: false,
        vision: false,
      },
    }));
  }

  createLlmService(connection?: ResolvedConnection): LlmService {
    if (!connection) {
      throw new Error(
        "CodexModelProvider.createLlmService requires a resolved connection"
      );
    }
    return new CodexLlmAdapter(connection, this.mcpConfig);
  }

  async requiresPlatformCredits(_ref: ModelRef): Promise<boolean> {
    return false; // User-funded via ChatGPT subscription
  }
}
