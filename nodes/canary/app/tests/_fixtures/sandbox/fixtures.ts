// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/_fixtures/sandbox/fixtures`
 * Purpose: Shared test fixtures for sandbox container tests (P0.5, P0.5a, full LLM round-trip).
 * Scope: Provides runner helpers, container exec helpers (with configurable timeout), context setup/teardown, and common assertions. Does not contain test logic or assertions.
 * Invariants: All sandbox tests use same image, same limits defaults.
 * Side-effects: IO (Docker containers, filesystem)
 * Links: docs/spec/sandboxed-agents.md
 * @internal
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type Docker from "dockerode";

import {
  LlmProxyManager,
  type SandboxRunnerAdapter,
} from "@/adapters/server/sandbox";
import type {
  GraphRunRequest,
  SandboxProgramContract,
  SandboxRunResult,
} from "@/ports";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

export const SANDBOX_IMAGE = "cogni-sandbox-runtime:latest";
export const SANDBOX_OPENCLAW_IMAGE = "cogni-sandbox-openclaw:latest";
export const SANDBOX_INTERNAL_NETWORK = "sandbox-internal";
export const GATEWAY_CONTAINER = "openclaw-gateway";

/** Default limits for sandbox tests - tight timeouts to fail fast.
 *  Full proxy+sandbox flow completes in <1s; 3s is generous headroom. */
export const DEFAULT_LIMITS = {
  maxRuntimeSec: 3,
  maxMemoryMb: 128,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Context Types
// ─────────────────────────────────────────────────────────────────────────────

export interface SandboxTestContext {
  runner: SandboxRunnerAdapter;
  workspace: string;
  docker: Docker;
}

export interface SandboxTestContextWithProxy extends SandboxTestContext {
  litellmMasterKey: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Generate unique run ID for container naming */
export function uniqueRunId(prefix = "test"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Verify sandbox image exists, throw descriptive error if not */
export async function assertSandboxImageExists(docker: Docker): Promise<void> {
  try {
    await docker.getImage(SANDBOX_IMAGE).inspect();
  } catch {
    throw new Error(
      `Sandbox image ${SANDBOX_IMAGE} not found. Run: pnpm sandbox:docker:build`
    );
  }
}

/** Verify sandbox-internal network exists (for P0.5a tests) */
export async function assertInternalNetworkExists(
  docker: Docker
): Promise<void> {
  try {
    await docker.getNetwork(SANDBOX_INTERNAL_NETWORK).inspect();
  } catch {
    throw new Error(
      `Network ${SANDBOX_INTERNAL_NETWORK} not found. Start dev stack: pnpm dev:infra`
    );
  }
}

/** Ensure nginx:alpine image is available (pulled if missing).
 *  Call in beforeAll so the pull happens within hookTimeout, not testTimeout. */
export async function ensureProxyImage(docker: Docker): Promise<void> {
  const image = "nginx:alpine";
  try {
    await docker.getImage(image).inspect();
  } catch {
    await new Promise<void>((resolve, reject) => {
      docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
        if (err) return reject(err);
        docker.modem.followProgress(stream, (pullErr: Error | null) =>
          pullErr ? reject(pullErr) : resolve()
        );
      });
    });
  }
}

/** Verify LiteLLM is reachable (for P0.5 proxy tests) */
export async function assertLitellmReachable(): Promise<void> {
  try {
    const response = await fetch("http://localhost:4000/health/liveliness");
    if (!response.ok) {
      throw new Error(`LiteLLM health check failed: ${response.status}`);
    }
  } catch (err) {
    throw new Error(
      `LiteLLM not reachable at localhost:4000. Start dev stack: pnpm dev:infra. Error: ${err}`
    );
  }
}

/** Create temporary workspace directory */
export async function createWorkspace(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-`));
}

/** Clean up workspace directory */
export async function cleanupWorkspace(workspace: string): Promise<void> {
  await fs.rm(workspace, { recursive: true, force: true });
}

/** Remove orphaned proxy containers/volumes via label filter (cogni.role=llm-proxy) */
export async function cleanupOrphanedProxies(docker: Docker): Promise<number> {
  return LlmProxyManager.cleanupSweep(docker);
}

// ─────────────────────────────────────────────────────────────────────────────
// Container Exec Helpers (for stack tests against running compose services)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a shell command inside a running container via docker exec.
 * Returns demuxed stdout+stderr as a string.
 * Uses hijack:true with bounded timeout (per MEMORY.md dockerode gotchas).
 */
export async function execInContainer(
  docker: Docker,
  containerName: string,
  cmd: string,
  timeoutMs = 5000
): Promise<string> {
  const container = docker.getContainer(containerName);
  const exec = await container.exec({
    Cmd: ["sh", "-c", cmd],
    AttachStdout: true,
    AttachStderr: true,
  });

  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: Buffer[] = [];

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      stream.destroy();
      resolve();
    }, timeoutMs);
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });

  return LlmProxyManager.demuxDockerStream(Buffer.concat(chunks));
}

// ─────────────────────────────────────────────────────────────────────────────
// Gateway Workspace Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensure /workspace/current exists inside the gateway container.
 * Idempotent: clones from the read-only git-sync mirror only if .git is absent.
 * Uses git rev-parse (not test -d) because git-sync uses worktrees where .git is a file.
 * Call in beforeAll for any test suite that needs the writable workspace.
 */
export async function ensureGatewayWorkspace(docker: Docker): Promise<void> {
  await execInContainer(
    docker,
    GATEWAY_CONTAINER,
    "git -C /workspace/current rev-parse --git-dir >/dev/null 2>&1 || git clone /repo/current /workspace/current",
    60_000
  );
}

/**
 * Create a throwaway git clone inside the gateway container for isolated test work.
 * Returns the path. Caller is responsible for cleanup via `cleanupGatewayDir()`.
 */
export async function createGatewayTestClone(
  docker: Docker,
  name: string
): Promise<string> {
  const dir = `/workspace/_test_${name}`;
  await execInContainer(
    docker,
    GATEWAY_CONTAINER,
    `rm -rf ${dir} && git clone /repo/current ${dir}`,
    30_000
  );
  return dir;
}

/** Remove a directory inside the gateway container. Best-effort. */
export async function cleanupGatewayDir(
  docker: Docker,
  dir: string
): Promise<void> {
  await execInContainer(docker, GATEWAY_CONTAINER, `rm -rf ${dir}`, 10_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Runner Helpers
// ─────────────────────────────────────────────────────────────────────────────

export interface RunOptions {
  maxRuntimeSec?: number;
  maxMemoryMb?: number;
}

/** Test billing account ID for sandbox tests */
export const TEST_BILLING_ACCOUNT_ID = "test-billing-account";

// ─────────────────────────────────────────────────────────────────────────────
// Gateway GraphRunRequest Fixture
// ─────────────────────────────────────────────────────────────────────────────

/** Deterministic stateKey for gateway stack tests (not a real UUID — easy to spot in logs). */
export const TEST_GATEWAY_STATE_KEY = "00000000-0000-0000-0000-stack-test-gw";

/**
 * Build a GraphRunRequest for gateway (SandboxGraphProvider) stack tests.
 * Uses deterministic defaults; override any field via `overrides`.
 */
export function makeGatewayRunRequest(
  overrides: Partial<GraphRunRequest> = {}
): GraphRunRequest {
  const runId = overrides.runId ?? uniqueRunId("gw");
  return {
    runId,
    ingressRequestId: runId,
    graphId: "sandbox:openclaw" as GraphRunRequest["graphId"],
    stateKey: TEST_GATEWAY_STATE_KEY,
    modelRef: { providerKey: "platform", modelId: "cogni/test-model" },
    messages: [{ role: "user", content: "Hello" }],
    caller: {
      billingAccountId: TEST_BILLING_ACCOUNT_ID,
      virtualKeyId: "test-vk",
      requestId: runId,
      traceId: runId,
      userId: "test-user",
    },
    ...overrides,
  } as GraphRunRequest;
}

/** Run command in sandbox with network=none and llmProxy enabled */
export async function runWithProxy(
  ctx: SandboxTestContextWithProxy,
  command: string,
  options?: RunOptions
): Promise<SandboxRunResult> {
  return ctx.runner.runOnce({
    runId: uniqueRunId(),
    workspacePath: ctx.workspace,
    image: SANDBOX_IMAGE,
    argv: [command],
    limits: {
      maxRuntimeSec: options?.maxRuntimeSec ?? DEFAULT_LIMITS.maxRuntimeSec,
      maxMemoryMb: options?.maxMemoryMb ?? DEFAULT_LIMITS.maxMemoryMb,
    },
    networkMode: { mode: "none" },
    llmProxy: {
      enabled: true,
      billingAccountId: TEST_BILLING_ACCOUNT_ID,
      attempt: 0,
    },
  });
}

/** Run command in sandbox with network=none, NO proxy (pure isolation) */
export async function runIsolated(
  ctx: SandboxTestContext,
  command: string,
  options?: RunOptions
): Promise<SandboxRunResult> {
  return ctx.runner.runOnce({
    runId: uniqueRunId(),
    workspacePath: ctx.workspace,
    image: SANDBOX_IMAGE,
    argv: [command],
    limits: {
      maxRuntimeSec: options?.maxRuntimeSec ?? DEFAULT_LIMITS.maxRuntimeSec,
      maxMemoryMb: options?.maxMemoryMb ?? DEFAULT_LIMITS.maxMemoryMb,
    },
    networkMode: { mode: "none" },
  });
}

/** Run command in sandbox with internal network (P0.5a) */
export async function runOnInternalNetwork(
  ctx: SandboxTestContext,
  command: string,
  options?: RunOptions
): Promise<SandboxRunResult> {
  return ctx.runner.runOnce({
    runId: uniqueRunId(),
    workspacePath: ctx.workspace,
    image: SANDBOX_IMAGE,
    argv: [command],
    limits: {
      maxRuntimeSec: options?.maxRuntimeSec ?? DEFAULT_LIMITS.maxRuntimeSec,
      maxMemoryMb: options?.maxMemoryMb ?? DEFAULT_LIMITS.maxMemoryMb,
    },
    networkMode: {
      mode: "internal",
      networkName: SANDBOX_INTERNAL_NETWORK,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// LLM Round-Trip Helpers (full-stack: agent → proxy → LiteLLM → mock-openai-api)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Model names matching litellm.test.config.yaml.
 * Keep in sync with tests/_fakes/ai/test-constants.ts.
 */
export const SANDBOX_TEST_MODELS = {
  default: "test-model",
  free: "test-free-model",
  paid: "test-paid-model",
} as const;

/** Limits for LLM round-trip tests — more headroom than infra-only tests. */
export const LLM_ROUNDTRIP_LIMITS = {
  maxRuntimeSec: 8,
  maxMemoryMb: 256,
} as const;

export interface AgentLlmOptions {
  messages: Array<{ role: string; content: string }>;
  model?: string;
  maxRuntimeSec?: number;
  maxMemoryMb?: number;
}

export interface AgentLlmResult {
  result: SandboxRunResult;
  envelope: SandboxProgramContract;
}

/**
 * Run the sandbox agent script (run.mjs) with LLM proxy enabled.
 *
 * Writes messages.json to workspace, runs `node /agent/run.mjs` with
 * COGNI_MODEL set to the requested model, and returns both the raw
 * SandboxRunResult and the parsed SandboxProgramContract envelope.
 *
 * This exercises the full path:
 *   run.mjs → socat → socket → nginx proxy → LiteLLM → mock-openai-api
 */
export async function runAgentWithLlm(
  ctx: SandboxTestContextWithProxy,
  options: AgentLlmOptions
): Promise<AgentLlmResult> {
  const cogniDir = path.join(ctx.workspace, ".cogni");
  mkdirSync(cogniDir, { recursive: true });
  writeFileSync(
    path.join(cogniDir, "messages.json"),
    JSON.stringify(options.messages)
  );

  const result = await ctx.runner.runOnce({
    runId: uniqueRunId("agent-llm"),
    workspacePath: ctx.workspace,
    image: SANDBOX_IMAGE,
    argv: ["node", "/agent/run.mjs"],
    limits: {
      maxRuntimeSec:
        options.maxRuntimeSec ?? LLM_ROUNDTRIP_LIMITS.maxRuntimeSec,
      maxMemoryMb: options.maxMemoryMb ?? LLM_ROUNDTRIP_LIMITS.maxMemoryMb,
    },
    networkMode: { mode: "none" },
    llmProxy: {
      enabled: true,
      billingAccountId: TEST_BILLING_ACCOUNT_ID,
      attempt: 0,
      env: { COGNI_MODEL: options.model ?? SANDBOX_TEST_MODELS.default },
    },
  });

  let envelope: SandboxProgramContract;
  try {
    envelope = JSON.parse(result.stdout.trim()) as SandboxProgramContract;
  } catch {
    envelope = {
      payloads: [],
      meta: {
        durationMs: 0,
        error: {
          code: "parse_error",
          message: `stdout not valid JSON: ${result.stdout.slice(0, 200)}`,
        },
      },
    };
  }

  return { result, envelope };
}
