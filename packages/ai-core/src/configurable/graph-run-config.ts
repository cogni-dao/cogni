// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-core/configurable/graph-run-config`
 * Purpose: JSON-serializable config schema for LangGraph RunnableConfig.configurable.
 * Scope: Defines what can travel through configurable; does NOT contain secrets.
 * Invariants:
 *   - NO_SECRETS_IN_CONFIGURABLE: Only toolIds, model, run metadata. OAuth/MCP auth resolved from ALS.
 *   - RUNID_SERVER_AUTHORITY: runId only from provider/invoker, never from client payload.
 *   - JSON-serializable (no functions, no object instances).
 * Side-effects: none
 * Links: GRAPH_EXECUTION.md, LANGGRAPH_AI.md
 * @public
 */

import { z } from "zod";

/**
 * GraphRunConfig schema.
 *
 * This is passed via `RunnableConfig.configurable` when invoking graphs.
 * Must be JSON-serializable — no functions, no object instances.
 *
 * NO_SECRETS_IN_CONFIGURABLE: OAuth tokens, MCP credentials, and other
 * secrets are resolved from AsyncLocalStorage runtime context, NOT from
 * configurable.
 */
export const GraphRunConfigSchema = z.object({
  /** LiteLLM model alias (e.g., "devstral", "gpt-4o") */
  model: z.string(),

  /** Canonical run identity — provider-assigned, never from client */
  runId: z.string(),

  /** Retry attempt (P0: always 0; P1: incremented on resume) */
  attempt: z.number().int().nonnegative().default(0),

  /** Tenant for billing attribution */
  billingAccountId: z.string(),

  /** Actor performing execution, e.g. user:{id}, agent:{id}, or service:{name} */
  actorId: z.string().optional(),

  /** Tenant boundary for authorization. Defaults to billingAccountId at node app boundaries. */
  tenantId: z.string().optional(),

  /** Server-bound on-behalf-of user subject. Never supplied by tool args. */
  subjectId: z.string().optional(),

  /** Graph identifier for authorization context. */
  graphId: z.string().optional(),

  /** Per-user LiteLLM virtual key ID */
  virtualKeyId: z.string(),

  /** Distributed trace correlation (optional) */
  traceId: z.string().optional(),

  /**
   * Per-run tool allowlist.
   * Tools not in this list receive `policy_denied` error.
   * If undefined/empty, ALL tools are denied (DENY_BY_DEFAULT).
   */
  toolIds: z.array(z.string()).optional(),
});

/**
 * GraphRunConfig type.
 * Inferred from Zod schema for type safety.
 */
export type GraphRunConfig = z.infer<typeof GraphRunConfigSchema>;

/**
 * Partial config for cases where not all fields are known.
 */
export type PartialGraphRunConfig = Partial<GraphRunConfig>;
