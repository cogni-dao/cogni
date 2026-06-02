// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/ai/zdr-config.stack`
 * Purpose: Verify ZDR (Zero Data Retention) configuration in litellm.config.yaml
 * Scope: Config smoke test - parses YAML and asserts ZDR flag presence. Does not test runtime behavior or adapter wiring.
 * Invariants: ZDR-enabled models must have extra_body.provider.zdr === true in config.
 * Side-effects: none (reads config file only)
 * Notes: Runs in APP_ENV=test (no docker/adapters needed). Guards against config regressions.
 * Links: infra/compose/runtime/configs/litellm.config.yaml, https://openrouter.ai/docs/guides/features/zdr#per-request-zdr-enforcement
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

describe("ZDR Configuration", () => {
  it("ZDR-enabled models have provider.zdr=true in config", () => {
    // Read and parse litellm config
    const configContent = fs.readFileSync(LITELLM_CONFIG_PATH, "utf-8");
    const config = yaml.parse(configContent);

    expect(config).toHaveProperty("model_list");
    expect(Array.isArray(config.model_list)).toBe(true);

    // Find ZDR-enabled models (Anthropic Claude + Google Gemini)
    const claudeSonnet = config.model_list.find(
      (m: { model_name: string }) => m.model_name === "claude-sonnet-4.5"
    );
    const claudeOpus = config.model_list.find(
      (m: { model_name: string }) => m.model_name === "claude-opus-4.5"
    );
    const geminiFlash = config.model_list.find(
      (m: { model_name: string }) => m.model_name === "gemini-2.5-flash"
    );
    const geminiPro = config.model_list.find(
      (m: { model_name: string }) => m.model_name === "gemini-3-pro"
    );

    // Assert all ZDR models exist
    expect(claudeSonnet).toBeDefined();
    expect(claudeOpus).toBeDefined();
    expect(geminiFlash).toBeDefined();
    expect(geminiPro).toBeDefined();

    // Assert ZDR flag is present and true
    expect(claudeSonnet?.litellm_params?.extra_body?.provider?.zdr).toBe(true);
    expect(claudeOpus?.litellm_params?.extra_body?.provider?.zdr).toBe(true);
    expect(geminiFlash?.litellm_params?.extra_body?.provider?.zdr).toBe(true);
    expect(geminiPro?.litellm_params?.extra_body?.provider?.zdr).toBe(true);

    // Assert is_zdr metadata is also set
    expect(claudeSonnet?.model_info?.is_zdr).toBe(true);
    expect(claudeOpus?.model_info?.is_zdr).toBe(true);
    expect(geminiFlash?.model_info?.is_zdr).toBe(true);
    expect(geminiPro?.model_info?.is_zdr).toBe(true);
  });

  it("Non-ZDR models do NOT have provider.zdr flag", () => {
    // Read and parse litellm config
    const configContent = fs.readFileSync(LITELLM_CONFIG_PATH, "utf-8");
    const config = yaml.parse(configContent);

    // Find non-ZDR models (OpenAI, DeepSeek, etc.)
    const gpt4oMini = config.model_list.find(
      (m: { model_name: string }) => m.model_name === "gpt-4o-mini"
    );
    const deepseek = config.model_list.find(
      (m: { model_name: string }) => m.model_name === "deepseek-v3.1"
    );

    expect(gpt4oMini).toBeDefined();
    expect(deepseek).toBeDefined();

    // Assert ZDR flag is NOT present
    expect(
      gpt4oMini?.litellm_params?.extra_body?.provider?.zdr
    ).toBeUndefined();
    expect(deepseek?.litellm_params?.extra_body?.provider?.zdr).toBeUndefined();

    // Assert is_zdr metadata is NOT set or false
    expect(gpt4oMini?.model_info?.is_zdr).toBeUndefined();
    expect(deepseek?.model_info?.is_zdr).toBeUndefined();
  });
});
