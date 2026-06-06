// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/model-provider.port`
 * Purpose: Port interface that every LLM provider must implement.
 * Scope: Defines the single gate for provider capabilities: model listing, LlmService creation,
 *   and billing policy. Replaces scattered provider-specific checks across the codebase.
 * Invariants:
 *   - ONE_GATE: No provider ships without implementing this shape.
 *   - POLICY_ON_PROVIDER: requiresPlatformCredits and usageSource live here, not on ModelRef.
 * Side-effects: none (interface only)
 * Links: docs/spec/multi-provider-llm.md
 * @public
 */

import type { ModelCapabilities, ModelRef, SourceSystem } from "@cogni/ai-core";
import type { ResolvedConnection } from "./connection-broker.port";
import type { LlmService } from "./llm.port";

/** Context for provider model listing — scoped to actor + tenant. */
export interface ProviderContext {
  readonly userId: string;
  readonly tenantId: string;
}

/**
 * A model available from a provider, with display and policy metadata.
 * Policy fields (requiresPlatformCredits, capabilities) live HERE, not on ModelRef.
 */
export interface ModelOption {
  readonly ref: ModelRef;
  readonly label: string;
  readonly requiresPlatformCredits: boolean;
  readonly providerLabel: string;
  readonly capabilities: ModelCapabilities;
}

/**
 * Port interface that every LLM provider must implement.
 *
 * This is the single authority for provider-specific behavior:
 * - What models are available (`listModels`)
 * - How to create an LlmService for execution (`createLlmService`)
 * - Whether a model consumes platform credits (`requiresPlatformCredits`)
 */
export interface ModelProviderPort {
  /** Registry key — matches ModelRef.providerKey */
  readonly providerKey: string;

  /** Billing source for usage attribution */
  readonly usageSource: SourceSystem;

  /** Whether this provider requires a user-owned connection to function */
  readonly requiresConnection: boolean;

  /** List models available from this provider for a given tenant */
  listModels(ctx: ProviderContext): Promise<ModelOption[]>;

  /** Create an LlmService instance for graph execution */
  createLlmService(connection?: ResolvedConnection): LlmService;

  /** Per-model policy: does using this model consume platform credits? */
  requiresPlatformCredits(ref: ModelRef): Promise<boolean>;
}
