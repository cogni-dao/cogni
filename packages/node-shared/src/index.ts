// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/node-shared`
 * Purpose: Shared pure utilities, constants, observability helpers, and domain types for all node apps.
 * Scope: Pure library — no env vars, no framework deps, no heavy runtime deps (pino/prom-client/wagmi stay app-local). Does NOT contain app-local code (env, db, hooks, config server, wagmi, logger, metrics).
 * Invariants:
 *   - PURE_LIBRARY: No process lifecycle, no env vars, no framework deps
 *   - NO_SRC_IMPORTS: Never imports @/ or src/ paths
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/package-isolation-rules
 * @public
 */

// --- AI utilities ---
export * from "./ai/content-scrubbing";
export * from "./ai/guards";
export * from "./ai/prompt-hash";
export * from "./ai/tool-catalog";

// --- Analytics ---
export * from "./analytics";

// --- Auth ---
export * from "./auth";

// --- Config (schema only — server accessor stays app-local) ---
export * from "./config/repoSpec.schema";

// --- Constants ---
export * from "./constants";

// --- Crypto ---
export { type AeadAAD, aeadDecrypt, aeadEncrypt } from "./crypto/aead";

// --- Errors ---
export * from "./errors";

// --- Observability ---
export * from "./observability";

// --- Schemas ---
export * from "./schemas/litellm.spend-logs.schema";

// --- Stubs ---
export { default as ThreadStreamNoop } from "./stubs/thread-stream-noop";

// --- Time ---
export * from "./time/time-range";

// --- Util ---
export * from "./util";
export { deriveAccountIdFromApiKey } from "./util/accountId";

// --- Utils (money) ---
export * from "./utils/money";

// --- Web3 ---
export * from "./web3";
