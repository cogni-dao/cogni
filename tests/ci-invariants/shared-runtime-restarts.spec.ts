// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/shared-runtime-restarts`
 * Purpose: Keep dependency health failures from triggering shared-state restart loops.
 * Scope: Production Compose service policy, shared by all environment reconciles.
 * Invariants: Health remains observable; Docker owns process-exit restarts.
 * Side-effects: IO (reads the runtime Compose declaration).
 * Links: bug.5489, docs/spec/vm-watchdog.md
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const compose = yaml.parse(
  readFileSync(
    path.resolve(__dirname, "../../infra/compose/runtime/docker-compose.yml"),
    "utf8"
  )
) as {
  services: Record<
    string,
    { labels?: string[]; restart?: string; healthcheck?: { test?: unknown } }
  >;
};

describe("shared runtime recovery ownership", () => {
  for (const name of [
    "postgres",
    "temporal-postgres",
    "doltgres",
    "redis",
    "temporal",
  ]) {
    it(`${name} preserves health reporting without health-triggered restarts`, () => {
      const service = compose.services[name];
      expect(service.labels).toContain("autoheal=false");
      expect(service.labels).not.toContain("autoheal=true");
      expect(service.restart).toBe("unless-stopped");
      expect(service.healthcheck?.test).toBeDefined();
    });
  }
});
