// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/env/build`
 * Purpose: Build-time environment variable validation using Zod schema.
 * Scope: Validates process.env for build-time only; provides buildEnv object. Does not handle runtime or client vars.
 * Invariants: Only processes vars needed during Docker build/pnpm build; validates at build time; fails fast on missing required build vars.
 * Side-effects: process.env
 * Notes: Build-time config = only what the bundler truly needs.
 *        Only add here when you have non-secret, non-runtime values that must be known at build
 *        (e.g. public asset prefix, static feature flags baked into the client). Currently minimal.
 * Links: Environment configuration specification
 * @public
 */

import { z } from "zod";

const buildSchema = z.object({
  // Currently no build-time environment variables required
  // Add here if needed: NEXT_PUBLIC_*, build flags, etc.
});

export const buildEnv = buildSchema.parse({
  // Currently empty - no build-time vars to validate
});

export type BuildEnv = typeof buildEnv;
