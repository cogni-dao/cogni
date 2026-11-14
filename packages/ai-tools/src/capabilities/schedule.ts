// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/schedule`
 * Purpose: Generic schedule management capability interface for AI tools.
 * Scope: Defines ScheduleCapability — generic CRUD over schedules. Does not contain implementations or app-domain concepts.
 * Invariants:
 *   - GENERIC_CRUD: No day-plan, planner, or UI concepts — pure schedule operations
 *   - CAPABILITY_INJECTION: Implementation injected at bootstrap, not imported
 * Side-effects: none (interface only)
 * Links: https://node-template.cognidao.org/knowledge/scheduled-run-grant-contract
 * @public
 */

/**
 * Schedule information returned by the capability.
 * Mirrors the wire format but as a plain object (no Dates).
 */
export interface ScheduleInfo {
  readonly id: string;
  readonly graphId: string;
  readonly input: Record<string, unknown>;
  readonly cron: string;
  readonly timezone: string;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly lastRunAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Parameters for creating a schedule.
 */
export interface ScheduleCreateParams {
  readonly graphId: string;
  readonly input: Record<string, unknown>;
  readonly cron: string;
  readonly timezone: string;
}

/**
 * Parameters for updating a schedule.
 */
export interface ScheduleUpdateParams {
  readonly input?: Record<string, unknown>;
  readonly cron?: string;
  readonly timezone?: string;
  readonly enabled?: boolean;
}

/**
 * Generic schedule management capability.
 *
 * Implementation is injected at bootstrap time (per CAPABILITY_INJECTION).
 * The implementation is responsible for:
 * - Resolving the calling user from execution context (e.g., ALS)
 * - Enforcing RLS/tenant scoping
 * - Resolving billing account for create operations
 */
export interface ScheduleCapability {
  /** List all schedules for the current user/tenant. */
  list(): Promise<readonly ScheduleInfo[]>;
  /** Create a new schedule. */
  create(input: ScheduleCreateParams): Promise<ScheduleInfo>;
  /** Update an existing schedule. */
  update(
    scheduleId: string,
    patch: ScheduleUpdateParams
  ): Promise<ScheduleInfo>;
  /** Delete a schedule. */
  remove(scheduleId: string): Promise<void>;
  /** Enable or disable a schedule. */
  setEnabled(scheduleId: string, enabled: boolean): Promise<ScheduleInfo>;
}
