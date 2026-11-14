// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/langgraph-graphs/tsup.config`
 * Purpose: Build configuration for langgraph-graphs package.
 * Scope: Build tooling only; does not contain runtime code.
 * Invariants: Output must be ESM with type declarations. Multi-entry for subpaths.
 * Side-effects: IO
 * Links: https://node-template.cognidao.org/knowledge/graph-execution-invariants
 * @internal
 */

import { defineConfig } from "tsup";

export const tsupConfig = defineConfig({
  entry: [
    "src/index.ts",
    "src/runtime/index.ts",
    "src/graphs/index.ts",
    "src/inproc/index.ts",
  ],
  format: ["esm"],
  dts: false, // tsc -b emits per-file declarations; tsup handles JS only
  clean: false, // preserve .d.ts files from tsc -b (incremental builds)
  sourcemap: true,
  platform: "node", // LangChain requires Node.js
  external: [
    "@langchain/core",
    "@langchain/langgraph",
    "@cogni/ai-core",
    "@cogni/ai-tools",
    "zod",
  ],
});

export default tsupConfig;
