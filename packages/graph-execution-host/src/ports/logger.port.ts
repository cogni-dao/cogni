// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/graph-execution-host/ports/logger.port`
 * Purpose: Minimal logger interface structurally compatible with pino's Logger.
 * Scope: Defines LoggerPort shape to avoid a pino runtime dependency. Does not contain logging implementation.
 * Invariants: PURE_LIBRARY — no env vars, no process lifecycle.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */
export interface LoggerPort {
  debug(obj: Record<string, unknown>, msg?: string): void;
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  child(bindings: Record<string, unknown>): LoggerPort;
}
