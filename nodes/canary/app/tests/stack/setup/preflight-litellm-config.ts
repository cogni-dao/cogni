// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/setup/preflight-litellm-config`
 * Purpose: Vitest globalSetup that verifies LiteLLM is loaded with test config, not prod config.
 * Scope: Queries /v1/models and checks for test-model. Does not validate individual model routing or test data.
 * Invariants:
 *   - Stack tests MUST run against litellm.test.config.yaml (routes to mock-openai-api)
 *   - Stale containers from dev:stack must not silently serve prod config during test runs
 * Side-effects: IO (HTTP request to LiteLLM)
 * Links: infra/compose/runtime/configs/litellm.test.config.yaml
 * @internal
 */

// biome-ignore lint/style/noDefaultExport: Vitest globalSetup requires default export
export default async function preflightLitellmConfig() {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const litellmMasterKey = process.env.LITELLM_MASTER_KEY;

  if (!litellmBaseUrl || !litellmMasterKey) {
    // Other preflights will catch missing env vars
    return;
  }

  console.log("\n🔍 Preflight: checking LiteLLM is loaded with test config...");

  try {
    const res = await fetch(`${litellmBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${litellmMasterKey}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      // Non-fatal: /v1/models might need different auth; preflight-mock-llm will catch real issues
      console.log(
        `⚠️  Could not query /v1/models (HTTP ${res.status}), skipping config check\n`
      );
      return;
    }

    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const modelIds = (data.data ?? []).map((m: { id: string }) => m.id);

    if (modelIds.includes("test-model")) {
      console.log(
        `✅ LiteLLM has test config (models: ${modelIds.join(", ")})\n`
      );
      return;
    }

    // Prod config detected — fail with actionable message
    throw new Error(
      [
        "",
        `❌ LiteLLM is loaded with PROD config (models: ${modelIds.join(", ")}).`,
        "   Stack tests require litellm.test.config.yaml with test-model.",
        "",
        "   This happens when dev:stack containers linger from a previous session.",
        "   Fix: restart with test config:",
        "",
        "     docker compose -f infra/compose/runtime/docker-compose.dev.yml down litellm",
        "     pnpm dev:stack:test",
        "",
      ].join("\n")
    );
  } catch (err) {
    if (err instanceof Error && err.message.includes("PROD config")) throw err;
    // Network errors are non-fatal here; preflight-mock-llm will catch them
    console.log(`⚠️  LiteLLM config check skipped: ${err}\n`);
  }
}
