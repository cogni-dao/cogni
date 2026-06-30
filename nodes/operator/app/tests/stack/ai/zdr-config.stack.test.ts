// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/zdr-config.stack`
 * Purpose: Verify the LiteLLM prod config is a clean Hyperbolic-only cut.
 * Scope: Config smoke test - parses YAML and asserts provider invariants. Does not test runtime behavior or adapter wiring.
 * Invariants:
 *   - Every route maps to Hyperbolic (`hyperbolic/` prefix + HYPERBOLIC_API_KEY).
 *   - No ZDR routes remain: ZDR was OpenRouter-specific; the OpenRouter provider
 *     was dropped, so no model may carry extra_body.provider.zdr or is_zdr.
 * Side-effects: none (reads config file only)
 * Notes: Runs in APP_ENV=test (no docker/adapters needed). Guards against config regressions.
 * Links: infra/compose/runtime/configs/litellm.config.yaml, https://docs.litellm.ai/docs/providers/hyperbolic
 * @public
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "yaml";

const LITELLM_CONFIG_PATH = path.join(
  process.cwd(),
  "infra/compose/runtime/configs/litellm.config.yaml"
);

type Route = {
  model_name: string;
  litellm_params?: {
    model?: string;
    api_key?: string;
    extra_body?: { provider?: { zdr?: boolean } };
  };
  model_info?: { is_zdr?: boolean };
};

function loadRoutes(): Route[] {
  const configContent = fs.readFileSync(LITELLM_CONFIG_PATH, "utf-8");
  const config = yaml.parse(configContent) as { model_list: Route[] };
  expect(Array.isArray(config.model_list)).toBe(true);
  return config.model_list;
}

describe("LiteLLM config — Hyperbolic-only clean cut", () => {
  it("every route targets Hyperbolic via the hyperbolic/ prefix + HYPERBOLIC_API_KEY", () => {
    const routes = loadRoutes();
    expect(routes.length).toBeGreaterThan(0);

    for (const route of routes) {
      expect(
        route.litellm_params?.model,
        `${route.model_name} must use the hyperbolic/ prefix`
      ).toMatch(/^hyperbolic\//);
      expect(
        route.litellm_params?.api_key,
        `${route.model_name} must use HYPERBOLIC_API_KEY`
      ).toBe("os.environ/HYPERBOLIC_API_KEY");
    }
  });

  it("no ZDR routes remain (OpenRouter provider was dropped)", () => {
    const routes = loadRoutes();

    for (const route of routes) {
      expect(
        route.litellm_params?.extra_body?.provider?.zdr,
        `${route.model_name} must not carry a zdr flag`
      ).toBeUndefined();
      expect(
        route.model_info?.is_zdr,
        `${route.model_name} must not carry is_zdr`
      ).toBeUndefined();
    }
  });
});
