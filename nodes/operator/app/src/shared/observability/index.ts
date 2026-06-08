// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/observability`
 * Purpose: Cross-cutting observability — combines app-local (pino/prom-client) + extracted (@cogni/node-shared) utilities.
 * Scope: Unified entry point for all observability utilities.
 * Invariants: No imports from bootstrap or ports.
 * Side-effects: none
 * @public
 */

import { EVENT_NAMES as NODE_SHARED_EVENT_NAMES } from "@cogni/node-shared";

export const EVENT_NAMES = {
  ...NODE_SHARED_EVENT_NAMES,
  ADAPTER_GITHUB_REPO_WRITE_ERROR: "adapter.github_repo_write.error",
  NODE_PUBLISH_SECRET_SHAPE_GENERATED:
    "feature.node_publish.secret_shape_generated",
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

// --- Extracted: events, context, client (from @cogni/node-shared) ---
// NOTE: logEvent/logRequestWarn/etc. come through ./server (which re-exports from @cogni/node-shared)
export {
  // Event payload types
  type AiActivityQueryCompletedEvent,
  type AiLlmCallEvent,
  type Clock,
  // Client-side logging
  clientLogger,
  // Context
  createRequestContext,
  type EventBase,
  type PaymentsConfirmedEvent,
  type PaymentsIntentCreatedEvent,
  type PaymentsStateTransitionEvent,
  type PaymentsStatusReadEvent,
  type PaymentsVerifiedEvent,
  type RequestContext,
} from "@cogni/node-shared";
// --- App-local: server logger/metrics/redact (pino + prom-client runtime deps) ---
export * from "./server";
