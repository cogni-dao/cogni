// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox/sandbox-runner`
 * Purpose: Docker-based sandbox runner for network-isolated command execution with optional LLM proxy.
 * Scope: Implements SandboxRunnerPort using dockerode. Delegates proxy container lifecycle to LlmProxyManager. Does not handle billing reconciliation or graph execution.
 * Invariants:
 *   - Per SANDBOXED_AGENTS.md P0.5: One-shot containers, ephemeral per command
 *   - Per NETWORK_DEFAULT_DENY: Containers run with NetworkMode: 'none' by default
 *   - Per SECRETS_HOST_ONLY: No credentials passed to container; LLM auth via host proxy
 *   - Per LLM_VIA_SOCKET_ONLY: LLM access via unix socket bridge (Docker volume at /llm-sock)
 * Side-effects: IO (creates/removes Docker containers and volumes, starts proxy containers)
 * Links: docs/spec/sandboxed-agents.md, src/ports/sandbox-runner.port.ts
 * @internal
 */

import { PassThrough } from "node:stream";

import Docker from "dockerode";
import type { Logger } from "pino";

import type {
  SandboxRunnerPort,
  SandboxRunResult,
  SandboxRunSpec,
} from "@/ports";
import { makeLogger } from "@/shared/observability";

import { type LlmProxyHandle, LlmProxyManager } from "./llm-proxy-manager";

/** Default max output size: 2MB */
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;

/** Default process limit per container */
const DEFAULT_PIDS_LIMIT = 256;

/** Socket directory inside container for LLM proxy.
 *  MUST NOT be under /run — sandbox containers mount tmpfs at /run which would mask
 *  a volume mount beneath it. Using a top-level path avoids the conflict entirely. */
const CONTAINER_LLM_SOCKET_DIR = "/llm-sock";
/** Socket filename inside container */
const CONTAINER_LLM_SOCKET_NAME = "llm.sock";
/** Full socket path inside container */
const CONTAINER_LLM_SOCKET_PATH = `${CONTAINER_LLM_SOCKET_DIR}/${CONTAINER_LLM_SOCKET_NAME}`;

/** Options for SandboxRunnerAdapter */
export interface SandboxRunnerAdapterOptions {
  /** LiteLLM master key for proxy authentication. Required if using llmProxy. */
  litellmMasterKey?: string;
  /** LiteLLM host:port (default: localhost:4000) */
  litellmHost?: string;
}

/**
 * Docker-based sandbox runner adapter.
 *
 * Per SANDBOXED_AGENTS.md P0.5: Containers are one-shot and ephemeral.
 * Each runOnce call:
 * 1. Optionally starts LLM proxy (if llmProxy enabled)
 * 2. Creates a new container with network=none
 * 3. Mounts the workspace directory (and proxy socket if enabled)
 * 4. Runs the command
 * 5. Collects stdout/stderr (with truncation)
 * 6. Removes the container
 * 7. Stops the proxy and collects audit logs
 */
export class SandboxRunnerAdapter implements SandboxRunnerPort {
  private readonly docker: Docker;
  private readonly log: Logger;
  private readonly litellmMasterKey: string | undefined;
  private readonly litellmHost: string;
  private readonly proxyManager: LlmProxyManager;

  constructor(options?: SandboxRunnerAdapterOptions) {
    this.docker = new Docker();
    this.log = makeLogger({ component: "SandboxRunnerAdapter" });
    this.litellmMasterKey = options?.litellmMasterKey;
    this.litellmHost = options?.litellmHost ?? "litellm:4000"; // Docker DNS
    this.proxyManager = new LlmProxyManager();
  }

  /**
   * Stop all running proxy containers and release resources.
   * Call this in test teardown or process exit handlers.
   */
  async dispose(): Promise<void> {
    await this.proxyManager.stopAll();
  }

  async runOnce(spec: SandboxRunSpec): Promise<SandboxRunResult> {
    const {
      runId,
      workspacePath,
      image,
      argv,
      limits,
      mounts = [],
      volumes = [],
      networkMode,
      llmProxy,
    } = spec;
    const containerName = `sandbox-${runId}-${Date.now()}`;

    // Resolve network mode (default: none for complete isolation)
    const networkConfig = networkMode ?? { mode: "none" as const };

    // Validate internal network mode requires a network name
    if (networkConfig.mode === "internal" && !networkConfig.networkName) {
      throw new Error("networkMode.networkName required when mode is internal");
    }

    // Determine Docker network mode string
    const dockerNetworkMode =
      networkConfig.mode === "internal" && networkConfig.networkName
        ? networkConfig.networkName
        : "none";

    const maxOutputBytes = limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;

    // Start LLM proxy if enabled
    let proxyHandle: LlmProxyHandle | undefined;
    if (llmProxy?.enabled) {
      if (!this.litellmMasterKey) {
        throw new Error(
          "litellmMasterKey required in adapter options when llmProxy is enabled"
        );
      }
      const t0 = Date.now();
      proxyHandle = await this.proxyManager.start({
        runId,
        attempt: llmProxy.attempt,
        litellmMasterKey: this.litellmMasterKey,
        billingAccountId: llmProxy.billingAccountId,
        litellmHost: this.litellmHost,
      });
      this.log.debug({ runId, elapsed: Date.now() - t0 }, "proxy.start done");
    }

    this.log.debug(
      {
        runId,
        containerName,
        argv,
        workspacePath,
        mountCount: mounts.length,
        networkMode: dockerNetworkMode,
        llmProxyEnabled: !!proxyHandle,
      },
      "Starting sandbox container"
    );

    // Build bind mounts: workspace (always rw) + additional mounts
    const binds = [
      `${workspacePath}:/workspace:rw`,
      ...mounts.map((m) => `${m.hostPath}:${m.containerPath}:${m.mode}`),
    ];

    // Build volume mounts (for socket sharing via Docker volume - hermetic)
    const volumeMounts: Docker.MountSettings[] = [];
    if (proxyHandle) {
      // Mount the socket volume rw — unix socket connect() requires write permission.
      volumeMounts.push({
        Type: "volume",
        Source: proxyHandle.socketVolume,
        Target: CONTAINER_LLM_SOCKET_DIR,
        ReadOnly: false,
      });
    }
    // Named volume mounts from spec (e.g., git-sync repo_data)
    for (const v of volumes) {
      volumeMounts.push({
        Type: "volume",
        Source: v.volume,
        Target: v.containerPath,
        ReadOnly: v.readOnly ?? true,
      });
    }

    // Build environment variables
    const envVars: string[] = [];
    if (proxyHandle) {
      // Per SANDBOXED_AGENTS.md: Agent uses OPENAI_API_BASE to hit the proxy
      envVars.push("OPENAI_API_BASE=http://localhost:8080");
      envVars.push(`RUN_ID=${runId}`);
      envVars.push(`LLM_PROXY_SOCKET=${CONTAINER_LLM_SOCKET_PATH}`);
    }
    // Add any custom env vars from llmProxy config
    if (llmProxy?.env) {
      for (const [key, value] of Object.entries(llmProxy.env)) {
        envVars.push(`${key}=${value}`);
      }
    }

    let container: Docker.Container | undefined;
    let result: SandboxRunResult;

    try {
      // Create container with strict isolation and security hardening
      container = await this.docker.createContainer({
        Image: image,
        name: containerName,
        // The entrypoint.sh handles socat bridge startup, then runs command via bash
        // We pass the command as a single string argument to be run via bash -lc
        Cmd: argv.length > 0 ? [argv.join(" ")] : [],
        // Environment variables (OPENAI_API_BASE, RUN_ID, etc.)
        Env: envVars.length > 0 ? envVars : undefined,
        HostConfig: {
          // Network mode: 'none' for isolation, or internal network name
          NetworkMode: dockerNetworkMode,
          // Memory limit
          Memory: limits.maxMemoryMb * 1024 * 1024,
          MemorySwap: limits.maxMemoryMb * 1024 * 1024, // No swap
          // Bind mounts: workspace + additional mounts
          Binds: binds,
          // Volume mounts: socket volume for proxy (hermetic - works on all platforms)
          Mounts: volumeMounts.length > 0 ? volumeMounts : undefined,
          // Manual removal - AutoRemove races with log collection
          AutoRemove: false,
          // Security: read-only root filesystem with tmpfs for writable areas
          ReadonlyRootfs: true,
          Tmpfs: {
            "/tmp": "rw,noexec,nosuid,size=64m",
            // /run needs to be writable for socat and other runtime files
            "/run": "rw,noexec,nosuid,size=8m",
          },
          // Drop all capabilities
          CapDrop: ["ALL"],
          // No privileged mode
          Privileged: false,
          // Prevent privilege escalation
          SecurityOpt: ["no-new-privileges:true"],
          // Limit number of processes to prevent fork bombs
          PidsLimit: DEFAULT_PIDS_LIMIT,
        },
        // Working directory
        WorkingDir: "/workspace",
        // Run as non-root user (matches Dockerfile)
        User: "sandboxer",
      });

      // Start container
      const t1 = Date.now();
      await container.start();
      this.log.debug(
        { runId, elapsed: Date.now() - t1 },
        "container.start done"
      );

      // Wait for completion with timeout (properly cleaned up)
      const waitResult = await this.waitWithTimeout(
        container,
        limits.maxRuntimeSec * 1000
      );
      this.log.debug(
        {
          runId,
          timedOut: waitResult.timedOut,
          statusCode: waitResult.statusCode,
          elapsed: Date.now() - t1,
        },
        "waitWithTimeout done"
      );

      // Handle timeout - kill container first
      if (waitResult.timedOut) {
        this.log.warn({ runId, containerName }, "Sandbox container timed out");
        try {
          await container.kill();
        } catch {
          // Container may already be stopped
        }
        const logs = await this.collectLogs(container, maxOutputBytes);
        result = {
          ok: false,
          stdout: logs.stdout,
          stderr: logs.stderr || "Command timed out",
          exitCode: -1,
          errorCode: "timeout",
          outputTruncated: logs.truncated,
        };
      } else {
        // Collect logs after container exits
        const logs = await this.collectLogs(container, maxOutputBytes);

        // Check if OOM killed
        const inspection = await container.inspect().catch(() => null);
        const oomKilled = inspection?.State?.OOMKilled ?? false;

        if (oomKilled) {
          this.log.warn(
            { runId, containerName },
            "Sandbox container OOM killed"
          );
          result = {
            ok: false,
            stdout: logs.stdout,
            stderr: logs.stderr,
            exitCode: waitResult.statusCode,
            errorCode: "oom_killed",
            outputTruncated: logs.truncated,
          };
        } else {
          this.log.debug(
            { runId, containerName, exitCode: waitResult.statusCode },
            "Sandbox container completed"
          );
          result = {
            ok: waitResult.statusCode === 0,
            stdout: logs.stdout,
            stderr: logs.stderr,
            exitCode: waitResult.statusCode,
            outputTruncated: logs.truncated,
          };
        }
      }
    } catch (error) {
      this.log.error(
        { runId, containerName, error },
        "Sandbox container execution failed"
      );
      result = {
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : "Unknown error",
        exitCode: -1,
        errorCode: "internal",
      };
    } finally {
      // Container cleanup ONLY — always runs
      if (container) {
        try {
          await container.remove({ force: true });
        } catch {
          // Container may already be removed or never started
        }
      }
    }

    // Proxy stop + billing extraction — after container cleanup, before return.
    // Runs on ALL paths (success, timeout, OOM, error) because any LLM calls
    // that happened before failure still need billing.
    if (proxyHandle) {
      try {
        const proxyResult = await this.proxyManager.stop(runId);
        if (proxyResult.logPath) {
          this.log.debug(
            { runId, logPath: proxyResult.logPath },
            "LLM proxy stopped, audit log at"
          );
        }
        result = { ...result, proxyBillingEntries: proxyResult.billingEntries };
      } catch (err) {
        this.log.warn({ runId, error: err }, "Failed to stop LLM proxy");
      }
    }

    return result;
  }

  /**
   * Wait for container with timeout.
   * Properly cleans up timeout to prevent timer leaks.
   */
  private async waitWithTimeout(
    container: Docker.Container,
    timeoutMs: number
  ): Promise<{ statusCode: number; timedOut: boolean }> {
    let timeoutId: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<{ statusCode: number; timedOut: true }>(
      (resolve) => {
        timeoutId = setTimeout(
          () => resolve({ statusCode: -1, timedOut: true }),
          timeoutMs
        );
      }
    );

    const waitPromise = container.wait().then((result) => ({
      statusCode: result.StatusCode,
      timedOut: false as const,
    }));

    try {
      return await Promise.race([waitPromise, timeoutPromise]);
    } finally {
      // Always clear the timeout to prevent leaks
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Collect stdout and stderr from container logs.
   * Uses dockerode's demuxStream for proper stream handling.
   * Enforces output size limits to prevent memory exhaustion.
   */
  private async collectLogs(
    container: Docker.Container,
    maxBytes: number
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    try {
      const logStream = await container.logs({
        stdout: true,
        stderr: true,
        follow: false,
      });

      // If logStream is a Buffer (non-TTY container), parse it directly
      if (Buffer.isBuffer(logStream)) {
        return this.parseDemuxedBuffer(logStream, maxBytes);
      }

      // If it's a stream, collect with demux
      return await this.collectFromStream(logStream, maxBytes);
    } catch {
      return { stdout: "", stderr: "", truncated: false };
    }
  }

  /**
   * Parse a demuxed buffer from Docker logs.
   * Docker logs are multiplexed: each frame has 8-byte header.
   * Byte 0: stream type (1=stdout, 2=stderr)
   * Bytes 4-7: frame size (big-endian)
   */
  private parseDemuxedBuffer(
    buffer: Buffer,
    maxBytes: number
  ): { stdout: string; stderr: string; truncated: boolean } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let totalBytes = 0;
    let truncated = false;

    let offset = 0;
    while (offset < buffer.length) {
      if (offset + 8 > buffer.length) break;

      const streamType = buffer.readUInt8(offset);
      const frameSize = buffer.readUInt32BE(offset + 4);

      if (offset + 8 + frameSize > buffer.length) break;

      // Check if we'd exceed max bytes
      if (totalBytes + frameSize > maxBytes) {
        truncated = true;
        break;
      }

      const content = buffer
        .subarray(offset + 8, offset + 8 + frameSize)
        .toString("utf8");

      if (streamType === 1) {
        stdout.push(content);
      } else if (streamType === 2) {
        stderr.push(content);
      }

      totalBytes += frameSize;
      offset += 8 + frameSize;
    }

    const result = {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      truncated,
    };

    // Add truncation marker if needed
    if (truncated) {
      result.stderr += "\n[OUTPUT TRUNCATED - exceeded max bytes]";
    }

    return result;
  }

  /**
   * Collect logs from a stream using dockerode's demux.
   */
  private async collectFromStream(
    logStream: NodeJS.ReadableStream,
    maxBytes: number
  ): Promise<{ stdout: string; stderr: string; truncated: boolean }> {
    return new Promise((resolve) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let totalBytes = 0;
      let truncated = false;

      const stdout = new PassThrough();
      const stderr = new PassThrough();

      stdout.on("data", (chunk: Buffer) => {
        if (totalBytes + chunk.length <= maxBytes) {
          stdoutChunks.push(chunk);
          totalBytes += chunk.length;
        } else {
          truncated = true;
        }
      });

      stderr.on("data", (chunk: Buffer) => {
        if (totalBytes + chunk.length <= maxBytes) {
          stderrChunks.push(chunk);
          totalBytes += chunk.length;
        } else {
          truncated = true;
        }
      });

      // Use dockerode's modem to demux the stream
      this.docker.modem.demuxStream(logStream, stdout, stderr);

      logStream.on("end", () => {
        const result = {
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          truncated,
        };

        if (truncated) {
          result.stderr += "\n[OUTPUT TRUNCATED - exceeded max bytes]";
        }

        resolve(result);
      });

      logStream.on("error", () => {
        resolve({ stdout: "", stderr: "", truncated: false });
      });

      // Safety timeout for stream collection
      setTimeout(() => {
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString("utf8"),
          stderr: Buffer.concat(stderrChunks).toString("utf8"),
          truncated,
        });
      }, 5000);
    });
  }
}
