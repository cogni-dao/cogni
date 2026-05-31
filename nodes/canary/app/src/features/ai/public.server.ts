// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/ai/public.server`
 * Purpose: Server-only exports for AI feature.
 * Scope: Re-exports server-only services that depend on Node.js modules (prom-client, etc). Does not implement logic.
 * Invariants:
 *   - NEVER import this file from client components or "use client" files
 *   - Only import from .server.ts files or route handlers with runtime: "nodejs"
 * Side-effects: none
 * Notes: Split from public.ts to prevent prom-client from being bundled in client code.
 * Links: Part of hexagonal architecture boundary enforcement
 * @public
 */

// Tool runner (for bootstrap wiring) - canonical source is @cogni/ai-core
export type {
  EmitAiEvent,
  ToolExecOptions,
  ToolRunner,
} from "@cogni/ai-core";
export { createToolRunner } from "@cogni/ai-core";
// Activity validation (for app facade)
export { validateActivityRange } from "./services/activity";
// Shared assistant message assembler (AiEvent[] → UIMessage)
export { assembleAssistantMessage } from "./services/assemble-assistant-message";
// Billing commit (for app-layer closure injection into UsageCommitDecorator)
export { commitUsageFact } from "./services/billing";
// Non-streaming completion (for app facade)
export { execute, executeStream } from "./services/completion";
// Message mappers (for app facade DTO conversion)
export {
  fromCoreMessage,
  type MessageDto,
  toCoreMessages,
  uiMessagesToMessageDtos,
} from "./services/mappers";
// Preflight credit check (used ONLY as closure source for PreflightCreditCheckDecorator DI;
// never call directly for enforcement — the decorator is the single enforcement path)
export { preflightCreditCheck } from "./services/preflight-credit-check";
// Secrets redaction for thread persistence
export { redactSecretsInMessages } from "./services/secrets-redaction";
