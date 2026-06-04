// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/ai/providers/openai-compatible.provider`
 * Purpose: ModelProviderPort for user-hosted OpenAI-compatible endpoints (Ollama, vLLM, llama.cpp, LM Studio).
 * Scope: Creates OpenAiCompatibleLlmAdapter from resolved connection. Dynamic model discovery via /v1/models.
 *   All models are user-funded (requiresPlatformCredits = false). Does not handle SSRF validation or credential storage.
 * Invariants:
 *   - requiresPlatformCredits always false (user-funded compute)
 *   - requiresConnection always true (needs endpoint URL)
 *   - DYNAMIC_MODEL_DISCOVERY: models fetched from user endpoint, not hardcoded
 * Side-effects: IO (DB query for connection, HTTP to user endpoint for model discovery)
 * Links: docs/spec/multi-provider-llm.md
 * @internal
 */

import type { ModelRef } from "@cogni/ai-core";
import { withTenantScope } from "@cogni/db-client";
import { connections } from "@cogni/db-schema";
import { type UserId, userActor } from "@cogni/ids";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ConnectionBrokerPort,
  LlmService,
  ModelOption,
  ModelProviderPort,
  ProviderContext,
  ResolvedConnection,
} from "@/ports";
import { makeLogger } from "@/shared/observability";
import { OpenAiCompatibleLlmAdapter } from "../openai-compatible/openai-compatible-llm.adapter";

const log = makeLogger({ module: "openai-compatible-provider" });

/**
 * Make model IDs human-readable.
 * llama-server uses GGUF filenames (sha256-...) as IDs.
 * Ollama uses "model:tag" format. Keep those as-is.
 */
export function humanizeModelId(id: string): string {
  // SHA256 hash from llama-server GGUF path — show truncated
  if (id.startsWith("sha256-")) {
    return `Local Model (${id.slice(7, 15)}...)`;
  }
  return id;
}

/** Extract baseUrl and apiKey from a resolved connection's credential blob. */
function connectionToEndpoint(conn: ResolvedConnection): {
  baseUrl: string;
  apiKey?: string | undefined;
} {
  return {
    baseUrl: conn.credentials.accessToken,
    apiKey: conn.credentials.accountId || undefined,
  };
}

export class OpenAiCompatibleModelProvider implements ModelProviderPort {
  readonly providerKey = "openai-compatible" as const;
  readonly usageSource = "ollama" as const;
  readonly requiresConnection = true;

  constructor(
    private readonly broker?: ConnectionBrokerPort | undefined,
    private readonly resolveDb?:
      | (() => Parameters<typeof withTenantScope>[0])
      | undefined
  ) {}

  async listModels(ctx: ProviderContext): Promise<ModelOption[]> {
    if (!this.broker || !this.resolveDb) return [];

    // Find active connection for this user's tenant
    const db = this.resolveDb();
    let connectionId: string | undefined;
    try {
      const rows = await withTenantScope(
        db,
        userActor(ctx.userId as UserId),
        async (tx) =>
          tx
            .select({ id: connections.id })
            .from(connections)
            .where(
              and(
                eq(connections.billingAccountId, ctx.tenantId),
                eq(connections.provider, "openai-compatible"),
                isNull(connections.revokedAt)
              )
            )
            .limit(1)
      );
      connectionId = rows[0]?.id;
    } catch (err) {
      log.warn({ err }, "Failed to query connections for model discovery");
      return [];
    }

    if (!connectionId) return [];

    // Resolve credentials and probe endpoint
    let conn: ResolvedConnection;
    try {
      conn = await this.broker.resolve(connectionId, {
        actorId: ctx.userId,
        tenantId: ctx.tenantId,
      });
    } catch (err) {
      log.warn({ err }, "Failed to resolve connection for model discovery");
      return [];
    }

    const endpoint = connectionToEndpoint(conn);

    // Fetch models from user's endpoint
    try {
      const headers: Record<string, string> = {};
      if (endpoint.apiKey) {
        headers.Authorization = `Bearer ${endpoint.apiKey}`;
      }
      const res = await fetch(`${endpoint.baseUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];

      const data = (await res.json()) as {
        data?: Array<{ id: string; owned_by?: string }>;
      };
      const models = data.data ?? [];

      return models.map((m) => ({
        ref: {
          providerKey: this.providerKey,
          modelId: m.id,
          connectionId,
        },
        label: humanizeModelId(m.id),
        requiresPlatformCredits: false,
        providerLabel: "Local LLM",
        capabilities: {
          streaming: true,
          tools: false,
          structuredOutput: false,
          vision: false,
        },
      }));
    } catch (err) {
      log.warn({ err }, "Failed to discover models from endpoint");
      return [];
    }
  }

  createLlmService(connection?: ResolvedConnection): LlmService {
    if (!connection) {
      throw new Error(
        "OpenAiCompatibleModelProvider.createLlmService requires a resolved connection"
      );
    }
    const endpoint = connectionToEndpoint(connection);
    return new OpenAiCompatibleLlmAdapter(endpoint);
  }

  async requiresPlatformCredits(_ref: ModelRef): Promise<boolean> {
    return false;
  }
}
