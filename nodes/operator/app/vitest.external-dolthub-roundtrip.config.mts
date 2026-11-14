// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `vitest.external-dolthub-roundtrip.config`
 * Purpose: External round-trip proof — the operator's REAL knowledge + work-item
 *   adapters create a DoltHub repo, contribute+merge+push, then recover by clone.
 * Scope: tests/external/dolthub/knowledge-roundtrip.external.test.ts only. Needs a
 *   live Doltgres (Testcontainers/Docker) + DoltHub push creds + a test owner.
 * Invariants:
 *   - Skips unless DOLTHUB_API_TOKEN + DOLTHUB_EXTERNAL_TEST_OWNER + DOLT_CREDS_JWK
 *     + DOLT_CREDS_KEYID are set AND Docker is reachable.
 *   - Pushes ONLY to the explicit test owner (never cogni-dao) — fail closed.
 *   - Resolves @cogni/* workspace packages from src (via tsconfig.e2e-roundtrip.json)
 *     so it does NOT depend on a prior `pnpm build`.
 * Side-effects: Docker containers; durable repo creation under the test owner.
 * Links: https://cognidao.org/knowledge/dolthub-mirror-bootstrap, .context/dolthub-e2e-roundtrip-plan.md
 * @public
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { expand } from "dotenv-expand";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const env = config({ path: path.resolve(__dirname, "../../../.env.test") });
expand(env);

export default defineConfig({
  root: __dirname,
  plugins: [tsconfigPaths({ projects: ["./tsconfig.e2e-roundtrip.json"] })],
  test: {
    include: ["tests/external/dolthub/knowledge-roundtrip.external.test.ts"],
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true, execArgv: ["--dns-result-order=ipv4first"] },
    },
    sequence: { concurrent: false },
    testTimeout: 300_000,
    hookTimeout: 180_000,
  },
  resolve: {
    alias: { "@tests": path.resolve(__dirname, "./tests") },
  },
});
