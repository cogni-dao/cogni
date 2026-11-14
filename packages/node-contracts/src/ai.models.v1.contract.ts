// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@contracts/ai.models.v1.contract`
 * Purpose: Defines operation contract for listing available AI models across all providers.
 * Scope: Provides Zod schema and types for models list endpoint wire format. Does not implement business logic or validation beyond schema definition.
 * Invariants: Contract remains stable; breaking changes require new version. All consumers use z.infer types.
 * Side-effects: none
 * Links: /api/v1/ai/models route, useModels hook, https://node-template.cognidao.org/knowledge/multi-provider-llm-routing
 * @internal
 */

import { ModelCapabilitiesSchema, ModelRefSchema } from "@cogni/ai-core";
import { z } from "zod";

/**
 * Model schema — one entry per model available to the user.
 * Policy metadata (requiresPlatformCredits, capabilities) comes from ModelProviderPort.
 */
export const ModelSchema = z.object({
  ref: ModelRefSchema,
  label: z.string(),
  requiresPlatformCredits: z.boolean(),
  providerLabel: z.string(),
  capabilities: ModelCapabilitiesSchema,
});

/**
 * Models list response
 * - models: Array of available models from all providers
 * - defaultRef: Server-computed default model reference (null if catalog empty)
 */
export const aiModelsOperation = {
  id: "ai.models.v1",
  summary: "List available AI models",
  description:
    "Returns list of available AI models across all providers with capabilities and billing metadata",
  input: z.object({}), // No input, GET request
  output: z.object({
    models: z.array(ModelSchema),
    defaultRef: ModelRefSchema.nullable(),
  }),
} as const;

// Export inferred types - all consumers MUST use these, never manual interfaces
export type Model = z.infer<typeof ModelSchema>;
export type ModelsOutput = z.infer<typeof aiModelsOperation.output>;
