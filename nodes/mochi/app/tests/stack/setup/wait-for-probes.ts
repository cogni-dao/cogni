// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/setup/wait-for-probes`
 * Purpose: Global setup for stack tests - ensures /livez and /readyz pass before running tests.
 * Scope: Polls liveness then readiness probes with explicit budgets; fails fast if probes don't pass. Does not run functional tests.
 * Invariants: Must run before any stack tests execute; /readyz is prerequisite for functional tests.
 *             Uses AbortController with timeouts that exceed the /readyz handler's internal budgets (~13s).
 * Side-effects: IO (HTTP probe requests to TEST_BASE_URL)
 * Notes: Implements CI contract: livez (10-20s, fail-fast) then readyz (60-120s, correctness gate).
 *        Validates /readyz contract (status === 'healthy'); prints response body on failures.
 * Links: vitest.stack.config.mts, docs/spec/health-probes.md, meta.readyz.read.v1.contract
 * @internal
 */

import { metaReadyzOutputSchema } from "@cogni/node-contracts";
import { Agent, type Dispatcher, setGlobalDispatcher } from "undici";

const LIVEZ_BUDGET_MS = 20_000; // 20s fail-fast budget
const LIVEZ_INTERVAL_MS = 1_000; // Poll every 1s (fast fail-fast signal)
const LIVEZ_TIMEOUT_MS = 500; // Request timeout < interval
const READYZ_BUDGET_MS = 120_000; // 120s correctness budget
const READYZ_INTERVAL_MS = 20_000; // Poll every 20s (handler needs up to 13s for sequential checks)
const READYZ_TIMEOUT_MS = 15_000; // Must exceed handler's internal timeouts (3s RPC + 5s Temporal + 5s worker)
const MAX_BODY_PREVIEW = 2048; // Cap error body output (2KB)

interface ProbeOptions {
  url: string;
  budgetMs: number;
  intervalMs: number;
  timeoutMs: number;
  probeName: string;
  validatePayload?: (json: unknown) => void;
}

async function pollEndpoint(options: ProbeOptions): Promise<void> {
  const { url, budgetMs, intervalMs, timeoutMs, probeName, validatePayload } =
    options;
  const startTime = Date.now();
  const maxAttempts = Math.ceil(budgetMs / intervalMs);
  let lastError: string | null = null;

  for (let i = 1; i <= maxAttempts; i++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.ok) {
        // For readyz, validate payload contract
        if (validatePayload) {
          const json = await response.json();
          validatePayload(json);
        }

        const elapsed = Date.now() - startTime;
        console.log(
          `✅ ${probeName} passed (HTTP ${response.status}) in ${elapsed}ms`
        );
        return;
      }

      // Non-OK response: capture body for diagnostics
      const bodyText = await response
        .text()
        .catch(() => "(could not read body)");
      const bodyPreview =
        bodyText.length > MAX_BODY_PREVIEW
          ? `${bodyText.slice(0, MAX_BODY_PREVIEW)}... (truncated)`
          : bodyText;

      lastError = `HTTP ${response.status}: ${bodyPreview}`;

      // Only print full body on final attempt to avoid spam
      if (i === maxAttempts) {
        console.log(
          `❌ ${probeName} attempt ${i}/${maxAttempts}: HTTP ${response.status}`
        );
        console.log(`   Response body: ${bodyPreview}`);
      } else {
        console.log(
          `⏳ ${probeName} attempt ${i}/${maxAttempts}: HTTP ${response.status}, retrying...`
        );
      }
    } catch (error) {
      clearTimeout(timeoutId);

      const errorMsg = error instanceof Error ? error.message : "fetch failed";
      // Preserve structured HTTP errors over abort/timeout noise
      const isAbort = errorMsg === "This operation was aborted";
      if (!isAbort || lastError === null) {
        lastError = errorMsg;
      }

      if (i === maxAttempts) {
        console.log(`❌ ${probeName} attempt ${i}/${maxAttempts}: ${errorMsg}`);
      } else {
        console.log(
          `⏳ ${probeName} attempt ${i}/${maxAttempts}: ${errorMsg}, retrying...`
        );
      }
    }

    if (i < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  const elapsed = Date.now() - startTime;
  throw new Error(
    `❌ ${probeName} failed after ${elapsed}ms (${maxAttempts} attempts). Last error: ${lastError}`
  );
}

// biome-ignore lint/style/noDefaultExport: Vitest globalSetup requires default export
export default async function waitForProbes() {
  // Set up undici dispatcher for localhost self-signed certs
  // (globalSetup runs before setupFiles, so we need this here)
  const strictAgent = new Agent({
    connect: {
      rejectUnauthorized: true,
    },
  });

  const localhostAgent = new Agent({
    connect: {
      rejectUnauthorized: false, // Accept self-signed certs for localhost
    },
  });

  const dispatcher = {
    dispatch(
      opts: Dispatcher.DispatchOptions,
      handler: Dispatcher.DispatchHandler
    ) {
      const origin = String(opts.origin ?? "");
      const isLocalhost =
        origin.startsWith("https://localhost") ||
        origin.startsWith("https://127.0.0.1");

      const agent = isLocalhost ? localhostAgent : strictAgent;
      return agent.dispatch(opts, handler);
    },
    close() {
      return Promise.all([strictAgent.close(), localhostAgent.close()]).then(
        () => undefined
      );
    },
    destroy(err?: Error | null) {
      if (err) {
        strictAgent.destroy(err);
        localhostAgent.destroy(err);
      } else {
        strictAgent.destroy();
        localhostAgent.destroy();
      }
      return Promise.resolve();
    },
  } as Dispatcher;

  setGlobalDispatcher(dispatcher);

  const baseUrl = process.env.TEST_BASE_URL;
  if (!baseUrl) {
    throw new Error("TEST_BASE_URL environment variable is required");
  }

  console.log("\n🔍 Stack probe validation (CI contract):");
  console.log(`   Base URL: ${baseUrl}`);

  // Step 1: Poll /livez (fail-fast signal, no payload validation)
  const livezUrl = new URL("/livez", baseUrl).toString();
  console.log(`\n1️⃣  Polling /livez (${LIVEZ_BUDGET_MS / 1000}s budget)...`);
  await pollEndpoint({
    url: livezUrl,
    budgetMs: LIVEZ_BUDGET_MS,
    intervalMs: LIVEZ_INTERVAL_MS,
    timeoutMs: LIVEZ_TIMEOUT_MS,
    probeName: "Liveness",
  });

  // Step 2: Poll /readyz (correctness gate, validate contract)
  const readyzUrl = new URL("/readyz", baseUrl).toString();
  console.log(`\n2️⃣  Polling /readyz (${READYZ_BUDGET_MS / 1000}s budget)...`);
  await pollEndpoint({
    url: readyzUrl,
    budgetMs: READYZ_BUDGET_MS,
    intervalMs: READYZ_INTERVAL_MS,
    timeoutMs: READYZ_TIMEOUT_MS,
    probeName: "Readiness",
    validatePayload: (json: unknown) => {
      const result = metaReadyzOutputSchema.safeParse(json);
      if (!result.success) {
        throw new Error(
          `Invalid /readyz payload: ${JSON.stringify(result.error.issues)}`
        );
      }
      if (result.data.status !== "healthy") {
        throw new Error(
          `Expected status='healthy', got '${result.data.status}'`
        );
      }
    },
  });

  console.log("\n✅ Stack is ready - proceeding with functional tests\n");
}
