// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/meta/meta-endpoints.stack`
 * Purpose: Verify public meta endpoints are reachable and return expected shapes.
 * Scope: Black-box HTTP checks against running stack. Does not test internal app logic or database state.
 * Invariants: Uses TEST_BASE_URL for host; assumes stack started via dev:stack:test or docker:test:stack.
 * Side-effects: IO
 * Notes: Requires running stack; tests /livez, /readyz, /openapi.json, /meta/route-manifest endpoints.
 * Links: /livez, /readyz, /openapi.json, /meta/route-manifest
 * @public
 */

import {
  metaLivezOutputSchema,
  metaReadyzOutputSchema,
} from "@cogni/node-contracts";
import { expect, test } from "vitest";

function baseUrl(path: string): string {
  const root = process.env.TEST_BASE_URL ?? "http://localhost:3000/";
  return new URL(path.replace(/^\//, ""), root).toString();
}

test("[meta] /livez returns alive status (liveness probe)", async () => {
  const response = await fetch(baseUrl("/livez"));
  expect(response.status).toBe(200);

  const body = await response.json();
  const parsed = metaLivezOutputSchema.safeParse(body);
  expect(parsed.success).toBe(true);

  if (parsed.success) {
    expect(parsed.data.status).toBe("alive");
    expect(typeof parsed.data.timestamp).toBe("string");
  }
});

test("[meta] /readyz returns healthy status (readiness probe)", async () => {
  const response = await fetch(baseUrl("/readyz"));
  expect(response.status).toBe(200);

  const body = await response.json();
  const parsed = metaReadyzOutputSchema.safeParse(body);
  expect(parsed.success).toBe(true);

  if (parsed.success) {
    expect(parsed.data.status).toBe("healthy");
    expect(typeof parsed.data.timestamp).toBe("string");
  }
});

test("[meta] openapi.json is available", async () => {
  const response = await fetch(baseUrl("/openapi.json"));
  expect(response.status).toBe(200);

  const body = await response.json();
  expect(body).toHaveProperty("openapi");
  expect(body).toHaveProperty("paths");
});

test("[meta] route manifest returns routes", async () => {
  const response = await fetch(baseUrl("/meta/route-manifest"));
  expect(response.status).toBe(200);

  const body = await response.json();
  expect(body).toMatchObject({ version: 1 });
  expect(Array.isArray(body.routes)).toBe(true);
  expect(body.routes.length).toBeGreaterThan(0);
  expect(body.routes[0]).toHaveProperty("path");
});
