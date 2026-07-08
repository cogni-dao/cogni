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
  NODE_ACCESS_REQUEST_COMPLETE: "feature.node_access_request.complete",
  NODE_SECRET_WRITE_COMPLETE: "feature.node_secret_write.complete",
  NODE_PREVIEW_PROMOTE_COMPLETE: "feature.node_preview_promote.complete",
  NODE_SCHEDULES_SYNC_COMPLETE: "feature.node_schedules_sync.complete",
  NODE_DISTRIBUTION_ACTIVATION_COMPLETE:
    "feature.node_distribution_activation.complete",
  NODE_DAO_RESET_COMPLETE: "feature.node_dao_reset.complete",
  // defineScheduledJob dispatcher: one cron fire of a registered scheduled job.
  SCHEDULED_JOB_DISPATCH_RECEIVED: "feature.scheduled_job.dispatch_received",
  SCHEDULED_JOB_DISPATCH_COMPLETE: "feature.scheduled_job.dispatch_complete",
  // Auth perimeter (proxy): request rejected before reaching any route handler,
  // so the request-scoped logger never sees it — emitted directly from the proxy.
  AUTH_PERIMETER_DENIED: "auth.perimeter.denied",
  // Node env-membership verb (story.5020 W4): the flag-gated DNS reverse-reconcile seam. v0 ships
  // DNS_REVERSE_RECONCILE off, so a node-env REMOVE only logs the intended Cloudflare prune (the
  // record lingers until TTL) and a node-env ADD only logs the intended upsert. See W3b.
  DNS_REVERSE_RECONCILE_SKIPPED: "dns.reverse_reconcile.skipped",
  DNS_FORWARD_RECONCILE_SKIPPED: "dns.forward_reconcile.skipped",
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
