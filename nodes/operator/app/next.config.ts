import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  transpilePackages: ["@cogni/node-app", "@cogni/node-ui-kit"],
  // In monorepo: tell Next.js where the workspace root is so standalone output
  // includes shared packages and resolves node_modules correctly.
  outputFileTracingRoot: path.join(__dirname, "../../../"),
  // Prevent Turbopack from bundling (and per-route duplicating) heavy server-only
  // packages. These resolve as Node.js requires at runtime instead. (spike.0203)
  serverExternalPackages: [
    // Native addons / build-tool incompatible
    "dockerode",
    "ssh2",
    "cpu-features",
    "tigerbeetle-node",
    "@cogni/financial-ledger",
    // Codex: subprocess spawns native binary — standalone tracing prunes platform optional deps
    "@openai/codex-sdk",
    "@openai/codex",
    "@openai/codex-linux-x64",
    // Heavy server-only deps — prevent per-route duplication in dev
    "@temporalio/client",
    "@grpc/grpc-js",
    "ioredis",
    "drizzle-orm",
    "postgres",
    "viem",
    "langfuse",
    "pino",
    "pino-pretty",
    "prom-client",
    "posthog-node",
    // Agent runtime: ESM NodeNext (`./types.js`) subpath imports turbopack can't
    // bundle in dev — resolve as Node requires at runtime (story.5116 local run).
    "@langchain/mcp-adapters",
  ],
  // WalletConnect pulls pino@7 → thread-stream@0.15 which ships test files
  // requiring 'tape'. outputFileTracingRoot broadens tracing to monorepo root,
  // exposing these. Exclude test/bench dirs from tracing.
  outputFileTracingExcludes: {
    "/**": [
      "**/thread-stream/test/**",
      "**/pino/test/**",
      "**/pino/benchmarks/**",
    ],
  },
  // task.0370: force-include the migrator subpath so the `FROM runner AS migrator`
  // stage can `import "drizzle-orm/postgres-js/migrator"` — nft would otherwise
  // prune it because the app itself only imports the driver.
  outputFileTracingIncludes: {
    "/**": [
      "**/node_modules/drizzle-orm/**/*",
      "**/node_modules/postgres/**/*",
    ],
  },
  // Temporary containment (bug.0157): WalletConnect pulls pino@7 → thread-stream
  // which ships test files requiring 'tape'/'tap'. Stub thread-stream for Turbopack
  // so it doesn't follow the test-file dependency chain during Client Component SSR.
  turbopack: {
    resolveAlias: {
      "thread-stream": "./src/shared/stubs/thread-stream-noop.ts",
    },
  },
  typescript: {
    tsconfigPath: "./tsconfig.app.json",
  },
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "sonarcloud.io",
        pathname: "/api/project_badges/measure",
      },
    ],
  },
};

export default nextConfig;
