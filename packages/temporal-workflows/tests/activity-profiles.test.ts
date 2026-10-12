// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/temporal-workflows/tests/activity-profiles.test`
 * Purpose: Locks the retry boundary between proven-idempotent graph execution and generic node dispatch.
 * Scope: Pure activity-option constants only; does not start a Temporal worker.
 * Invariants:
 *   - GRAPH_RETRY_REQUIRES_PERSISTED_DEDUP: graph runs retry transient delivery.
 *   - NODE_TASK_REMAINS_SINGLE_ATTEMPT: generic routes do not inherit retries.
 * Side-effects: none
 * Links: src/activity-profiles.ts, docs/spec/scheduler.md
 * @internal
 */

import { describe, expect, it } from "vitest";
import {
  GRAPH_EXECUTION_ACTIVITY_OPTIONS,
  IDEMPOTENT_GRAPH_EXECUTION_ACTIVITY_OPTIONS,
} from "../src/activity-profiles.js";

describe("graph activity profiles", () => {
  it("retries only the persisted-idempotency graph profile", () => {
    expect(IDEMPOTENT_GRAPH_EXECUTION_ACTIVITY_OPTIONS.retry).toEqual({
      initialInterval: "5 seconds",
      maximumInterval: "30 seconds",
      backoffCoefficient: 2,
      maximumAttempts: 6,
    });
    expect(GRAPH_EXECUTION_ACTIVITY_OPTIONS.retry.maximumAttempts).toBe(1);
  });
});
