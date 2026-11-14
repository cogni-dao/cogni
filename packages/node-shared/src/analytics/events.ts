// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/analytics/events`
 * Purpose: Product analytics event name registry — single source of truth for PostHog event names.
 * Scope: Defines namespaced event constants. Does not define payload schemas (see https://node-template.cognidao.org/knowledge/analytics-event-payloads).
 * Invariants:
 *   - All event names use "cogni." namespace prefix
 *   - Names are dot-separated, lowercase, snake_case segments
 *   - Max 20 events for MVP (keep count tight)
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/analytics-event-payloads
 * @public
 */

export const AnalyticsEvents = {
  // ── Auth ──────────────────────────────────────────────────
  /** User completed authentication (any provider). */
  AUTH_SIGNED_IN: "cogni.auth.signed_in",

  /** User linked an additional identity provider. */
  IDENTITY_PROVIDER_LINKED: "cogni.identity.provider_linked",

  // ── Agent Execution (Core Loop) ──────────────────────────
  /** Agent/graph run was requested. */
  AGENT_RUN_REQUESTED: "cogni.agent.run_requested",

  /** Agent/graph run completed successfully. */
  AGENT_RUN_COMPLETED: "cogni.agent.run_completed",

  /** Agent/graph run failed. */
  AGENT_RUN_FAILED: "cogni.agent.run_failed",

  // ── Tool Use ─────────────────────────────────────────────
  /** User created a new tool connection (OAuth provider link for tools). */
  TOOL_CONNECTION_CREATED: "cogni.tool.connection_created",

  // ── Artifacts ────────────────────────────────────────────
  /** Artifact created (PR, work item, statement). */
  ARTIFACT_CREATED: "cogni.artifact.created",

  // ── Billing ──────────────────────────────────────────────
  /** User purchased credits. */
  BILLING_CREDITS_PURCHASED: "cogni.billing.credits_purchased",

  /** Credits spent on an agent run. */
  BILLING_CREDITS_SPENT: "cogni.billing.credits_spent",

  // ── Rate Limits ──────────────────────────────────────────
  /** Rate limit hit (LLM provider or API). */
  RATE_LIMIT_HIT: "cogni.rate_limit.hit",

  // ── Scheduling ───────────────────────────────────────────
  /** Schedule created for automated runs. */
  SCHEDULE_CREATED: "cogni.schedule.created",
} as const;

export type AnalyticsEventName =
  (typeof AnalyticsEvents)[keyof typeof AnalyticsEvents];
