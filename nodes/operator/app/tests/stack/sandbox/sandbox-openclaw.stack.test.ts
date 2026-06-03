// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/stack/sandbox/sandbox-openclaw`
 * Purpose: Stack test proving OpenClaw runs inside the network-isolated sandbox and reaches LiteLLM through the socket proxy.
 * Scope: OpenClaw container boot, LLM proxy round-trip, stdout envelope shape, sandbox env isolation, proxy audit evidence.
 * Invariants:
 *   - Per NETWORK_DEFAULT_DENY: OpenClaw runs with network=none
 *   - Per LLM_VIA_SOCKET_ONLY: LLM access goes through localhost:8080 -> socket -> proxy
 *   - Per SECRETS_HOST_ONLY: Host/provider secrets never enter the OpenClaw sandbox container
 * Side-effects: IO (Docker containers, nginx proxy, filesystem)
 * Links: docs/spec/sandboxed-agents.md, work/projects/proj.sandboxed-agents.md
 * @public
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import Docker from "dockerode";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 90_000, hookTimeout: 20_000 });

import { SandboxRunnerAdapter } from "@/adapters/server/sandbox";
import type { SandboxRunResult } from "@/ports";

import {
  assertInternalNetworkExists,
  assertLitellmReachable,
  cleanupOrphanedProxies,
  cleanupWorkspace,
  createWorkspace,
  ensureProxyImage,
  type SandboxTestContextWithProxy,
  TEST_BILLING_ACCOUNT_ID,
  uniqueRunId,
} from "../../_fixtures/sandbox/fixtures";

const OPENCLAW_IMAGE = "cogni-sandbox-openclaw:latest";
const OPENCLAW_MODEL = "mock-stream";
const OPENCLAW_MODEL_REF = `cogni/${OPENCLAW_MODEL}`;

const OPENCLAW_ENV = {
  HOME: "/workspace",
  NODE_OPTIONS: "--max-old-space-size=1536",
  OPENCLAW_CONFIG_PATH: "/workspace/.openclaw/openclaw.json",
  OPENCLAW_STATE_DIR: "/workspace/.openclaw-state",
  OPENCLAW_LOAD_SHELL_ENV: "0",
} as const;

interface OpenClawEnvelope {
  payloads: ReadonlyArray<{
    text: string;
    mediaUrl?: string | null;
  }>;
  meta: {
    durationMs: number;
    error?: { code: string; message: string } | null;
    aborted?: boolean;
  };
}

let ctx: SandboxTestContextWithProxy | null = null;

describe("Sandbox OpenClaw Execution", () => {
  const docker = new Docker();
  const litellmMasterKey = process.env.LITELLM_MASTER_KEY;

  beforeAll(async () => {
    await cleanupOrphanedProxies(docker);

    if (!litellmMasterKey) {
      console.warn(
        "SKIPPING: LITELLM_MASTER_KEY not set. Start dev stack with: pnpm dev:infra"
      );
      return;
    }

    await assertOpenClawImageExists(docker);
    await ensureProxyImage(docker);
    await assertInternalNetworkExists(docker);
    await assertLitellmReachable();

    const workspace = await createWorkspace("sandbox-openclaw");
    await writeOpenClawWorkspace(workspace);

    ctx = {
      runner: new SandboxRunnerAdapter({
        litellmMasterKey,
      }),
      workspace,
      docker,
      litellmMasterKey,
    };
  });

  afterAll(async () => {
    if (ctx?.runner) {
      await ctx.runner.dispose();
    }
    if (ctx?.workspace) {
      await cleanupWorkspace(ctx.workspace);
    }
    await cleanupOrphanedProxies(docker);
    ctx = null;
  });

  it("boots OpenClaw and completes an LLM call through the sandbox proxy", async () => {
    if (!ctx) return;

    const result = await runOpenClaw(ctx);
    expect(result.ok, summarizeRunFailure(result)).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("LITELLM_MASTER_KEY");

    const envelope = parseOpenClawEnvelope(result);

    expect(envelope.payloads, JSON.stringify(envelope, null, 2)).toHaveLength(
      1
    );
    const payload = envelope.payloads[0];
    expect(payload?.text).toContain("MOCK_STREAM_OK");
    if (payload?.mediaUrl != null) {
      expect(payload.mediaUrl).toEqual(expect.any(String));
    }
    expect(envelope.meta.durationMs).toEqual(expect.any(Number));
    expect(envelope.meta.durationMs).toBeGreaterThanOrEqual(0);
    expect(envelope.meta.error ?? null).toBeNull();
    expect(envelope.meta.aborted ?? false).toBe(false);

    expect(result.proxyBillingEntries).toBeDefined();
    expect(result.proxyBillingEntries?.length).toBeGreaterThan(0);
    expect(result.proxyBillingEntries?.[0]?.litellmCallId).toEqual(
      expect.any(String)
    );
  });

  it("does not expose host LLM secrets in the OpenClaw sandbox env", async () => {
    if (!ctx) return;

    const result = await ctx.runner.runOnce({
      runId: uniqueRunId("openclaw-env"),
      workspacePath: ctx.workspace,
      image: OPENCLAW_IMAGE,
      argv: [
        [
          "env | grep -E '^(LITELLM_MASTER_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|ANTHROPIC_API_KEY)=' && echo LEAKED || echo SAFE",
          "test ! -f /workspace/.env",
          "test ! -f /workspace/.openclaw-state/.env",
        ].join(" && "),
      ],
      limits: { maxRuntimeSec: 10, maxMemoryMb: 512 },
      networkMode: { mode: "none" },
      llmProxy: {
        enabled: true,
        billingAccountId: TEST_BILLING_ACCOUNT_ID,
        attempt: 0,
        env: OPENCLAW_ENV,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("SAFE");
    expect(result.stdout).not.toContain("LEAKED");
  });
});

async function assertOpenClawImageExists(docker: Docker): Promise<void> {
  try {
    await docker.getImage(OPENCLAW_IMAGE).inspect();
  } catch {
    throw new Error(
      `OpenClaw sandbox image ${OPENCLAW_IMAGE} not found. Build the OpenClaw sandbox image before running this stack test.`
    );
  }
}

async function writeOpenClawWorkspace(workspace: string): Promise<void> {
  await mkdir(path.join(workspace, ".openclaw"), { recursive: true });
  await mkdir(path.join(workspace, ".cogni"), { recursive: true });

  await writeFile(
    path.join(workspace, ".openclaw", "openclaw.json"),
    `${JSON.stringify(openClawConfig(), null, 2)}\n`
  );
  await writeFile(
    path.join(workspace, ".cogni", "prompt.txt"),
    "Reply with exactly: hello from openclaw sandbox"
  );
  await writeFile(
    path.join(workspace, "AGENTS.md"),
    "You are running in the Cogni OpenClaw sandbox stack test.\n"
  );
  await writeFile(path.join(workspace, "SOUL.md"), "Sandbox test workspace.\n");
}

function openClawConfig(): unknown {
  return {
    models: {
      mode: "replace",
      providers: {
        cogni: {
          baseUrl: "http://localhost:8080/v1",
          apiKey: "sandbox-proxy-auth-placeholder",
          authHeader: false,
          api: "openai-completions",
          models: [
            {
              id: OPENCLAW_MODEL,
              name: "Cogni LiteLLM test model",
              api: "openai-completions",
              reasoning: false,
              input: ["text"],
              contextWindow: 32_000,
              maxTokens: 1024,
              cost: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
              },
            },
          ],
        },
      },
    },
    agents: {
      defaults: {
        model: { primary: OPENCLAW_MODEL_REF },
        workspace: "/workspace",
        repoRoot: "/workspace",
        skipBootstrap: true,
        timeoutSeconds: 55,
        sandbox: { mode: "off" },
      },
      list: [
        {
          id: "main",
          default: true,
          workspace: "/workspace",
          model: { primary: OPENCLAW_MODEL_REF },
          sandbox: { mode: "off" },
        },
      ],
    },
  };
}

async function runOpenClaw(
  ctx: SandboxTestContextWithProxy
): Promise<SandboxRunResult> {
  return ctx.runner.runOnce({
    runId: uniqueRunId("openclaw"),
    workspacePath: ctx.workspace,
    image: OPENCLAW_IMAGE,
    argv: [
      [
        "node /app/openclaw.mjs agent",
        "--local",
        "--agent main",
        '--message "$(cat /workspace/.cogni/prompt.txt)"',
        "--json",
        "--timeout 55",
      ].join(" "),
    ],
    limits: { maxRuntimeSec: 75, maxMemoryMb: 2048, maxOutputBytes: 4_000_000 },
    networkMode: { mode: "none" },
    llmProxy: {
      enabled: true,
      billingAccountId: TEST_BILLING_ACCOUNT_ID,
      attempt: 0,
      env: OPENCLAW_ENV,
    },
  });
}

function parseOpenClawEnvelope(result: SandboxRunResult): OpenClawEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.trim());
  } catch (err) {
    throw new Error(
      `OpenClaw stdout was not valid JSON: ${result.stdout.slice(0, 500)}`,
      { cause: err }
    );
  }

  if (!isOpenClawEnvelope(parsed)) {
    throw new Error(
      `OpenClaw stdout did not match SandboxProgramContract envelope: ${result.stdout.slice(0, 500)}`
    );
  }

  return parsed;
}

function summarizeRunFailure(result: SandboxRunResult): string {
  return JSON.stringify(
    {
      ok: result.ok,
      exitCode: result.exitCode,
      stdout: result.stdout.slice(0, 1_000),
      stderr: result.stderr.slice(0, 1_000),
    },
    null,
    2
  );
}

function isOpenClawEnvelope(value: unknown): value is OpenClawEnvelope {
  if (!isRecord(value)) return false;
  if (!Array.isArray(value.payloads)) return false;
  if (!isRecord(value.meta)) return false;
  if (typeof value.meta.durationMs !== "number") return false;

  return value.payloads.every((payload) => {
    if (!isRecord(payload)) return false;
    if (typeof payload.text !== "string") return false;
    return (
      payload.mediaUrl === undefined ||
      payload.mediaUrl === null ||
      typeof payload.mediaUrl === "string"
    );
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
