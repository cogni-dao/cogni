// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env`
 * Purpose: Public surface for environment configuration module with validated env objects and utility helpers.
 * Scope: Re-exports client/server env and provides raw env access helpers. Does not export internal schemas.
 * Invariants: Only re-exports public APIs; utility helpers fail fast on missing vars; maintains type safety.
 * Side-effects: process.env
 * Notes: Includes fallback helpers for edge cases; changes here affect environment module public API contract.
 * Links: ARCHITECTURE.md#public-surface
 * @public
 */

export type { BuildEnv } from "./build";
export { buildEnv } from "./build";
export type { ClientEnv } from "./client";
export { clientEnv } from "./client";
export type { ServerEnv } from "./server";
export { EnvValidationError, serverEnv } from "./server";

// Tiny helpers when needed
export const getEnv = (k: string): string | undefined => process.env[k];
export const requireEnv = (k: string): string => {
  const v = process.env[k];
  if (!v) throw new Error(`Missing env: ${k}`);
  return v;
};
