// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/ports/commit-usage-fact`
 * Purpose: Function signature for committing a usage fact to the billing ledger.
 * Scope: Defines the CommitUsageFactFn type injected into decorators. Does not contain ledger implementation or database access.
 * Invariants: PURE_LIBRARY — no env vars, no process lifecycle.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules, src/decorators/usage-commit.decorator.ts
 * @public
 */

import type { UsageFact } from "@cogni/ai-core";

import type { LoggerPort } from "./logger.port";
export type CommitUsageFactFn = (
  fact: UsageFact,
  log: LoggerPort
) => Promise<void>;
