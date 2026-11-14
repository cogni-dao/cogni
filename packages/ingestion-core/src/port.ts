// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ingestion-core/port`
 * Purpose: Port interfaces for activity source adapters — poll and webhook capabilities.
 * Scope: Pure interfaces. Does not contain implementations — those live in services/scheduler-worker/src/adapters/ingestion/.
 * Invariants:
 * - ADAPTERS_NOT_IN_CORE: This file defines PORTs (interfaces), not implementations.
 * - All adapter deps (octokit, discord.js) live in the adapter, never in this package.
 * - CAPABILITY_REQUIRED: DataSourceRegistration must have at least one of poll or webhook.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/attribution-epoch-ledger
 * @public
 */

import type {
  ActivityEvent,
  CollectParams,
  CollectResult,
  StreamDefinition,
} from "./model";

/**
 * Registration record binding a source's ingestion capabilities.
 * A source may support poll, webhook, or both.
 * At least one capability must be present (validated at container bootstrap).
 * Not a port itself — a capability manifest containing ports.
 */
export interface DataSourceRegistration {
  /** Source platform identifier: "github", "discord" */
  readonly source: string;

  /** Adapter version — bump on schema changes that affect payloadHash */
  readonly version: string;

  /** Poll capability — runs inside Temporal activities. */
  readonly poll?: PollAdapter;

  /** Webhook capability — runs inside feature services via HTTP request handlers. */
  readonly webhook?: WebhookNormalizer;
}

/**
 * Poll capability — runs inside Temporal activities.
 * Cursor-based incremental sync over a time window.
 */
export interface PollAdapter {
  /** Available streams this adapter can collect from */
  streams(): StreamDefinition[];

  /**
   * Collect activity events. Idempotent via deterministic event IDs.
   * Uses cursor for incremental sync (CURSOR_STATE_PERSISTED).
   *
   * @returns Events collected + updated cursor for next call
   */
  collect(params: CollectParams): Promise<CollectResult>;
}

/**
 * Webhook capability — runs inside feature services via HTTP request handlers.
 * Normalizes platform webhook payloads to ActivityEvent[].
 * Verification uses platform-specific OSS: @octokit/webhooks-methods (GitHub),
 * discord-interactions (Discord), etc.
 */
export interface WebhookNormalizer {
  /** Platform event types this normalizer handles (e.g., ["pull_request", "issues"]) */
  readonly supportedEvents: readonly string[];

  /**
   * Verify webhook signature. Must be called before normalize().
   * Implementation uses platform OSS — not bespoke crypto.
   * Async because @octokit/webhooks-methods uses Web Crypto API.
   */
  verify(
    headers: Record<string, string>,
    body: Buffer,
    secret: string
  ): Promise<boolean>;

  /**
   * Parse and normalize webhook payload to ActivityEvent[].
   * Returns empty array for events we don't care about.
   * Should not perform network I/O — all data comes from the payload.
   */
  normalize(
    headers: Record<string, string>,
    body: unknown
  ): Promise<ActivityEvent[]>;
}

/**
 * @deprecated Use DataSourceRegistration with poll capability instead.
 * Backward-compat type alias during migration.
 */
export type SourceAdapter = DataSourceRegistration & { poll: PollAdapter } & {
  /** @deprecated Access via registration.poll.streams() */
  streams(): StreamDefinition[];
  /** @deprecated Access via registration.poll.collect() */
  collect(params: CollectParams): Promise<CollectResult>;
  /** @deprecated Removed in favor of WebhookNormalizer */
  handleWebhook?(payload: unknown): Promise<ActivityEvent[]>;
};
