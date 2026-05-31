// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/setup/preflight-mock-llm`
 * Purpose: Vitest globalSetup that verifies LiteLLM can route to mock-openai-api before stack tests run.
 * Scope: Sends a single completion request through LiteLLM → mock-llm; fails fast with actionable instructions. Does not run functional tests.
 * Invariants: Must run after wait-for-probes (app is up) but before functional tests.
 * Side-effects: IO (HTTP requests to LiteLLM via LITELLM_BASE_URL)
 * Links: infra/compose/runtime/configs/litellm.test.config.yaml, tests/_fakes/ai/test-constants.ts
 * @internal
 */

const LITELLM_BUDGET_MS = 10_000; // 10s — LiteLLM may retry internally before responding
const LITELLM_INTERVAL_MS = 1_000;
const LITELLM_TIMEOUT_MS = 5_000; // LiteLLM internal retries can take a few seconds

// biome-ignore lint/style/noDefaultExport: Vitest globalSetup requires default export
export default async function preflightMockLlm() {
  const litellmBaseUrl = process.env.LITELLM_BASE_URL;
  const litellmMasterKey = process.env.LITELLM_MASTER_KEY;

  if (!litellmBaseUrl || !litellmMasterKey) {
    throw new Error(
      "LITELLM_BASE_URL and LITELLM_MASTER_KEY must be set for stack tests."
    );
  }

  console.log("\n🔍 Preflight: checking LiteLLM → mock-llm routing...");
  console.log(`   LiteLLM URL: ${litellmBaseUrl}`);

  const startTime = Date.now();
  const maxAttempts = Math.ceil(LITELLM_BUDGET_MS / LITELLM_INTERVAL_MS);
  let lastError: string | null = null;

  for (let i = 1; i <= maxAttempts; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), LITELLM_TIMEOUT_MS);

    try {
      const res = await fetch(`${litellmBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${litellmMasterKey}`,
        },
        body: JSON.stringify({
          model: "test-model",
          messages: [{ role: "user", content: "preflight" }],
        }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const elapsed = Date.now() - startTime;
        console.log(
          `✅ LiteLLM → mock-llm routing works (HTTP ${res.status}) in ${elapsed}ms\n`
        );
        return;
      }

      const body = await res.text().catch(() => "(could not read body)");
      lastError = `HTTP ${res.status}: ${body.slice(0, 512)}`;

      if (i === maxAttempts) {
        console.log(
          `❌ LiteLLM preflight attempt ${i}/${maxAttempts}: HTTP ${res.status}`
        );
        console.log(`   Response: ${body.slice(0, 512)}`);
      } else {
        console.log(
          `⏳ LiteLLM preflight attempt ${i}/${maxAttempts}: HTTP ${res.status}, retrying...`
        );
      }
    } catch (error) {
      clearTimeout(timeoutId);
      const msg = error instanceof Error ? error.message : "fetch failed";
      lastError = msg;

      if (i === maxAttempts) {
        console.log(`❌ LiteLLM preflight attempt ${i}/${maxAttempts}: ${msg}`);
      } else {
        console.log(
          `⏳ LiteLLM preflight attempt ${i}/${maxAttempts}: ${msg}, retrying...`
        );
      }
    }

    if (i < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, LITELLM_INTERVAL_MS));
    }
  }

  const elapsed = Date.now() - startTime;
  throw new Error(
    [
      `❌ LiteLLM → mock-llm preflight failed after ${elapsed}ms (${maxAttempts} attempts).`,
      `   Last error: ${lastError}`,
      "",
      "Is mock-llm running? Check:",
      "  docker ps --filter name=mock-llm",
      "",
      "To restart the test stack:",
      "  pnpm dev:stack:test",
    ].join("\n")
  );
}
