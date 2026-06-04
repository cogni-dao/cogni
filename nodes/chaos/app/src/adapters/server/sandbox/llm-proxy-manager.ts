// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@adapters/server/sandbox/llm-proxy-manager`
 * Purpose: Manages containerized Nginx proxy for sandbox LLM access.
 * Scope: Spawns/stops nginx:alpine containers via dockerode. Does not handle sandbox container lifecycle.
 * Invariants:
 *   - Per SECRETS_HOST_ONLY: LITELLM_MASTER_KEY stays in proxy container, never in sandbox
 *   - Per HOST_INJECTS_BILLING_HEADER: Proxy sets x-litellm-end-user-id
 *   - Per APPEND_ONLY_AUDIT: Access logs written by proxy container, collected on stop
 *   - No host-installed nginx required (hermetic)
 * Side-effects: IO (Docker containers, writes config files to tmpdir)
 * Links: docs/spec/sandboxed-agents.md, infra/compose/sandbox-proxy/nginx.conf.template
 * @internal
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Docker from "dockerode";
import type { Logger } from "pino";

import type { ProxyBillingEntry } from "@/ports";
import { serverEnv } from "@/shared/env";
import { makeLogger } from "@/shared/observability";

/** Nginx image for proxy container */
const NGINX_IMAGE = "nginx:alpine";

/**
 * Audit log path INSIDE the proxy container.
 * MUST NOT use /var/log/nginx/access.log — nginx:alpine symlinks it to /dev/stdout,
 * so `cat` reads a character device (returns nothing) instead of a file.
 */
const CONTAINER_AUDIT_LOG = "/tmp/audit.log";

/** Docker network where LiteLLM is reachable (internal: true — no internet egress) */
const PROXY_NETWORK = "sandbox-internal";

/** Configuration for starting an LLM proxy instance */
export interface LlmProxyConfig {
  /** Unique run ID for this sandbox execution */
  runId: string;
  /** Attempt number (for retry tracking) */
  attempt: number;
  /** LiteLLM master key for authentication */
  litellmMasterKey: string;
  /** Billing account ID for cost attribution (matches in-proc `user` field). Required for production. */
  billingAccountId: string;
  /** LiteLLM host:port as seen from proxy container (default: litellm:4000) */
  litellmHost?: string;
  /** Base directory for socket dirs and logs (default: os.tmpdir()/cogni-llm-proxy) */
  baseDir?: string;
}

/** Result of starting an LLM proxy */
export interface LlmProxyHandle {
  /** Docker volume name for socket sharing (mount this into sandbox) */
  socketVolume: string;
  /** Socket filename within the volume */
  socketName: string;
  /** Path to the access log file (after stop) */
  logPath: string;
  /** Path to the generated config file */
  configPath: string;
  /** Proxy container ID */
  containerId: string;
}

/** Result of stopping an LLM proxy — includes parsed billing data */
export interface ProxyStopResult {
  /** Path to the raw access log file on host */
  logPath: string | null;
  /** Billing entries parsed from the proxy audit log (one per LLM call) */
  billingEntries: readonly ProxyBillingEntry[];
}

/** Path to the nginx config template (lazy to avoid serverEnv() at import time) */
function getTemplatePath(): string {
  return join(
    serverEnv().COGNI_REPO_ROOT ?? "/nonexistent",
    "infra/compose/sandbox-proxy/nginx.conf.template"
  );
}

/**
 * Manages containerized Nginx proxy instances for sandbox LLM access.
 *
 * Per SANDBOXED_AGENTS.md P0.5: Each sandbox run gets its own proxy container
 * with isolated socket directory, config, and log files.
 *
 * Architecture:
 * - Proxy container runs nginx:alpine on sandbox-internal network
 * - Listens on unix socket in Docker volume (hermetic - works on all platforms)
 * - Sandbox container (network=none) mounts same volume
 * - socat in sandbox bridges localhost:8080 to socket
 */
/** Label applied to all proxy containers for sweep-based cleanup */
const PROXY_LABEL = "cogni.role=llm-proxy";

export class LlmProxyManager {
  private readonly docker: Docker;
  private readonly log: Logger;
  private readonly containers: Map<string, Docker.Container> = new Map();
  private readonly handles: Map<string, LlmProxyHandle> = new Map();
  private readonly volumes: Map<string, string> = new Map();

  constructor(docker?: Docker) {
    this.docker = docker ?? new Docker();
    this.log = makeLogger({ component: "LlmProxyManager" });
  }

  /**
   * Remove all containers and volumes with cogni.role=llm-proxy label.
   * Safe to call without an instance — uses Docker API label filter directly.
   * Call in test beforeAll/afterAll to clean up orphans from crashed runs.
   */
  static async cleanupSweep(docker?: Docker): Promise<number> {
    const d = docker ?? new Docker();
    const containers = await d.listContainers({
      all: true,
      filters: { label: [PROXY_LABEL] },
    });
    await Promise.all(
      containers.map((c) =>
        d
          .getContainer(c.Id)
          .remove({ force: true })
          .catch(() => {})
      )
    );
    // Clean matching volumes
    const volumes = await d.listVolumes({
      filters: { name: ["llm-socket-"] },
    });
    await Promise.all(
      (volumes.Volumes ?? []).map((v) =>
        d
          .getVolume(v.Name)
          .remove()
          .catch(() => {})
      )
    );
    return containers.length;
  }

  /**
   * Start an Nginx proxy container for a sandbox run.
   *
   * @param config - Proxy configuration
   * @returns Handle with socket volume name for mounting
   * @throws If proxy container fails to start
   */
  async start(config: LlmProxyConfig): Promise<LlmProxyHandle> {
    const {
      runId, // codeql[js/insecure-randomness] Run ID uniqueness — not security-sensitive
      attempt,
      litellmMasterKey,
      billingAccountId,
      litellmHost,
      baseDir,
    } = config;

    // Check if already running
    if (this.containers.has(runId)) {
      throw new Error(`Proxy already running for runId: ${runId}`);
    }

    // Create host directory for config and logs (SECRETS_HOST_ONLY: config stays on host)
    const base = baseDir ?? join(tmpdir(), "cogni-llm-proxy");
    const configDir = join(base, runId);
    const socketName = "llm.sock";
    const configPath = join(configDir, "nginx.conf");
    const logPath = join(configDir, "access.log");

    // Create Docker volume for socket sharing (hermetic - works on all platforms)
    // Using volumes instead of bind mounts avoids macOS osxfs unix socket issues
    const socketVolume = `llm-socket-${runId}`;

    this.log.debug({ runId, socketVolume }, "Starting LLM proxy container");

    // Create config directory on host
    mkdirSync(configDir, { recursive: true, mode: 0o700 });

    // Create Docker volume for socket
    await this.docker.createVolume({ Name: socketVolume });
    this.volumes.set(runId, socketVolume);

    // Generate config from template
    // Build metadata JSON for LiteLLM (run correlation + Langfuse observability)
    const metadataJson = JSON.stringify({
      run_id: runId,
      attempt,
      graph_id: "sandbox:agent",
      // Additional Langfuse fields can be added here
    });

    const configContent = this.generateConfig({
      socketPath: `/llm-sock/${socketName}`, // Path inside container
      logPath: CONTAINER_AUDIT_LOG, // Path inside container (avoids nginx:alpine symlink)
      runId,
      attempt,
      litellmMasterKey,
      billingAccountId, // User's billing account (required)
      litellmMetadataJson: metadataJson, // Run correlation + observability
      litellmHost: litellmHost ?? "litellm:4000", // Docker DNS
    });

    // Write config file
    writeFileSync(configPath, configContent, { mode: 0o600 });

    // Ensure nginx image is available
    await this.ensureImage(NGINX_IMAGE);

    // Create and start proxy container
    const containerName = `llm-proxy-${runId}`;
    const container = await this.docker.createContainer({
      Image: NGINX_IMAGE,
      name: containerName,
      Labels: {
        "cogni.role": "llm-proxy",
        "cogni.runId": runId,
      },
      HostConfig: {
        // Connect to same network as LiteLLM
        NetworkMode: PROXY_NETWORK,
        // Mount socket volume (rw so nginx can create socket)
        // Mount config file (ro) - bind mount is fine for regular files
        Binds: [`${configPath}:/etc/nginx/nginx.conf:ro`],
        Mounts: [
          {
            Type: "volume",
            Source: socketVolume,
            Target: "/llm-sock",
            ReadOnly: false,
          },
        ],
        AutoRemove: false,
      },
    });

    // Register IMMEDIATELY so stopAll/cleanupSweep can find it even if
    // readiness check fails or the test is aborted mid-flight.
    this.containers.set(runId, container);

    const handle: LlmProxyHandle = {
      socketVolume,
      socketName,
      logPath,
      configPath,
      containerId: container.id,
    };
    this.handles.set(runId, handle);

    await container.start();

    // Wait for proxy to be ready (5 attempts with exponential backoff: 50-800ms).
    // On failure: stop container + remove volume so we don't orphan resources.
    try {
      await this.waitForProxyReady(container, socketName, 2000);
    } catch (err) {
      await this.stop(runId);
      throw err;
    }

    this.log.info(
      { runId, socketVolume, containerId: container.id },
      "LLM proxy container started"
    );
    return handle;
  }

  /**
   * Stop the proxy container for a sandbox run.
   * Collects the access log and parses billing entries from it.
   *
   * @param runId - The run ID to stop
   * @returns Parsed billing entries + log path
   */
  async stop(runId: string): Promise<ProxyStopResult> {
    const container = this.containers.get(runId);
    const handle = this.handles.get(runId);
    const volumeName = this.volumes.get(runId);
    const emptyResult: ProxyStopResult = {
      logPath: handle?.logPath ?? null,
      billingEntries: [],
    };

    if (!container) {
      this.log.warn({ runId }, "No proxy container found to stop");
      return emptyResult;
    }

    this.log.debug({ runId }, "Stopping LLM proxy container");

    try {
      // Copy access log from container before stopping
      if (handle) {
        await this.copyLogFromContainer(container, handle.logPath);
      }

      // Stop and remove container
      await container.stop({ t: 2 }).catch(() => {
        // Container may already be stopped
      });
      await container.remove({ force: true }).catch(() => {
        // Container may already be removed
      });

      // Remove Docker volume
      if (volumeName) {
        try {
          await this.docker.getVolume(volumeName).remove();
        } catch {
          // Volume may already be removed or in use
        }
        this.volumes.delete(runId);
      }
    } catch (err) {
      this.log.warn({ runId, error: err }, "Error stopping proxy container");
    }

    this.containers.delete(runId);

    // Parse billing entries from the collected audit log
    const billingEntries = handle?.logPath
      ? this.parseAuditLog(handle.logPath, runId)
      : [];

    this.log.info(
      {
        runId,
        logPath: handle?.logPath,
        billingEntryCount: billingEntries.length,
      },
      "LLM proxy container stopped"
    );
    return { logPath: handle?.logPath ?? null, billingEntries };
  }

  /**
   * Clean up config directory for a run.
   * Call this after stop() when you're done with the logs.
   */
  cleanup(runId: string): void {
    const handle = this.handles.get(runId);
    // Remove config directory
    const configDir = handle?.configPath
      ? join(handle.configPath, "..")
      : undefined;
    if (configDir && existsSync(configDir)) {
      try {
        rmSync(configDir, { recursive: true, force: true });
        this.log.debug({ runId, configDir }, "Cleaned up config directory");
      } catch (err) {
        this.log.warn(
          { runId, error: err },
          "Failed to cleanup config directory"
        );
      }
    }
    this.handles.delete(runId);
  }

  /**
   * Check if a proxy is running for a given runId.
   */
  isRunning(runId: string): boolean {
    return this.containers.has(runId);
  }

  /**
   * Stop all running proxy containers (for cleanup).
   */
  async stopAll(): Promise<void> {
    const runIds = Array.from(this.containers.keys());
    await Promise.all(runIds.map((runId) => this.stop(runId)));
  }

  /**
   * Ensure Docker image is available, pull if needed.
   */
  private async ensureImage(imageName: string): Promise<void> {
    try {
      await this.docker.getImage(imageName).inspect();
    } catch {
      this.log.info({ imageName }, "Pulling Docker image");
      await new Promise<void>((resolve, reject) => {
        this.docker.pull(
          imageName,
          (err: Error | null, stream: NodeJS.ReadableStream) => {
            if (err) {
              reject(err);
              return;
            }
            // Follow the pull progress
            this.docker.modem.followProgress(
              stream,
              (pullErr: Error | null) => {
                if (pullErr) {
                  reject(pullErr);
                } else {
                  resolve();
                }
              }
            );
          }
        );
      });
    }
  }

  /**
   * Copy access log from container to host.
   * Demuxes Docker multiplexed frame headers so the file on disk is clean text.
   */
  private async copyLogFromContainer(
    container: Docker.Container,
    hostLogPath: string
  ): Promise<void> {
    try {
      // Exec cat to get access log content (container.logs() gives stdout, not file contents)
      const exec = await container.exec({
        Cmd: ["cat", CONTAINER_AUDIT_LOG],
        AttachStdout: true,
        AttachStderr: true,
      });

      const stream = await exec.start({ hijack: true, stdin: false });
      const chunks: Buffer[] = [];

      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          stream.destroy();
          resolve();
        }, 1000);
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

      if (chunks.length > 0) {
        const raw = Buffer.concat(chunks);
        const logContent = LlmProxyManager.demuxDockerStream(raw);
        writeFileSync(hostLogPath, logContent);
      }
    } catch {
      // Log collection is best-effort
      this.log.debug("Could not collect proxy access log");
    }
  }

  /**
   * Extract stdout payload from Docker multiplexed stream buffer.
   * Docker exec with hijack:true wraps output in 8-byte frame headers:
   *   Byte 0: stream type (1=stdout, 2=stderr)
   *   Bytes 1-3: padding
   *   Bytes 4-7: frame size (big-endian uint32)
   *   Next frameSize bytes: payload
   * Returns concatenated stdout payloads as UTF-8 string.
   */
  static demuxDockerStream(buffer: Buffer): string {
    const stdout: Buffer[] = [];
    let offset = 0;

    while (offset + 8 <= buffer.length) {
      const streamType = buffer.readUInt8(offset);
      const frameSize = buffer.readUInt32BE(offset + 4);

      if (offset + 8 + frameSize > buffer.length) break;

      if (streamType === 1) {
        stdout.push(buffer.subarray(offset + 8, offset + 8 + frameSize));
      }
      // streamType 2 = stderr, skip

      offset += 8 + frameSize;
    }

    return Buffer.concat(stdout).toString("utf8");
  }

  /**
   * Parse proxy audit log to extract billing entries.
   * Each log line has key=value pairs including litellm_call_id and litellm_response_cost.
   * Only lines with a valid litellm_call_id produce a billing entry.
   */
  private parseAuditLog(
    logPath: string,
    runId: string
  ): readonly ProxyBillingEntry[] {
    if (!existsSync(logPath)) {
      this.log.debug({ runId, logPath }, "No audit log file to parse");
      return [];
    }

    const raw = readFileSync(logPath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    const entries: ProxyBillingEntry[] = [];

    for (const line of lines) {
      const callIdMatch = line.match(/litellm_call_id=(\S+)/);
      const callId = callIdMatch?.[1];

      // Skip lines without a call ID (health checks, non-LLM requests)
      if (!callId || callId === "-") continue;

      const costMatch = line.match(/litellm_response_cost=(\S+)/);
      const costRaw = costMatch?.[1];
      let costUsd: number | undefined;
      if (costRaw && costRaw !== "-") {
        const parsed = Number.parseFloat(costRaw);
        if (Number.isFinite(parsed)) {
          costUsd = parsed;
        }
      }

      entries.push(
        costUsd !== undefined
          ? { litellmCallId: callId, costUsd }
          : { litellmCallId: callId }
      );
    }

    this.log.debug(
      { runId, lineCount: lines.length, billingEntryCount: entries.length },
      "Parsed proxy audit log"
    );
    return entries;
  }

  /**
   * Generate nginx config from template with variable substitution.
   */
  private generateConfig(vars: {
    socketPath: string;
    logPath: string;
    runId: string;
    attempt: number;
    litellmMasterKey: string;
    billingAccountId: string;
    litellmMetadataJson: string;
    litellmHost: string;
  }): string {
    // Read template
    if (!existsSync(getTemplatePath())) {
      throw new Error(`Nginx template not found: ${getTemplatePath()}`);
    }
    let template = readFileSync(getTemplatePath(), "utf-8");

    // Substitute variables (mimics envsubst)
    const substitutions: Record<string, string> = {
      SOCKET_PATH: vars.socketPath,
      ACCESS_LOG_PATH: vars.logPath,
      RUN_ID: vars.runId,
      ATTEMPT: String(vars.attempt),
      LITELLM_MASTER_KEY: vars.litellmMasterKey,
      BILLING_ACCOUNT_ID: vars.billingAccountId,
      LITELLM_METADATA_JSON: vars.litellmMetadataJson,
      LITELLM_HOST: vars.litellmHost,
    };

    for (const [key, value] of Object.entries(substitutions)) {
      // Replace both ${VAR} and $VAR patterns
      template = template.replace(new RegExp(`\\$\\{${key}\\}`, "g"), value);
      template = template.replace(
        new RegExp(`\\$${key}(?![A-Z_])`, "g"),
        value
      );
    }

    return template;
  }

  /**
   * Wait for proxy to be ready by checking socket inside container.
   * Uses docker exec to test socket exists in the volume.
   *
   * IMPORTANT: exec.start() returns an IncomingMessage stream that MUST be
   * consumed — otherwise it leaks an HTTP socket from the Node.js agent pool.
   * After ~5 leaked sockets, all subsequent Docker API calls hang forever.
   * We await the stream 'end' event (signals exec completion) before inspecting.
   */
  private async waitForProxyReady(
    container: Docker.Container,
    socketName: string,
    timeoutMs: number
  ): Promise<void> {
    const socketPath = `/llm-sock/${socketName}`;
    const start = Date.now();
    const backoffs = [50, 100, 200, 400, 800];
    let lastError: string | undefined;

    for (let attempt = 0; attempt < backoffs.length; attempt++) {
      if (Date.now() - start >= timeoutMs) break;

      try {
        const exec = await container.exec({
          Cmd: ["test", "-S", socketPath],
          AttachStdout: true,
          AttachStderr: true,
        });

        // hijack: true returns a Duplex whose 'end' fires reliably when
        // the exec finishes (unlike hijack: false IncomingMessage).
        // AttachStdout/Stderr MUST be true — Docker won't send the HTTP
        // upgrade response with nothing to attach, causing exec.start to hang.
        // Bounded await (500ms) + fallback to exec.inspect polling so we
        // never hang even if the stream doesn't emit 'end'.
        const stream = await exec.start({ hijack: true, stdin: false });
        let streamEnded = false;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => resolve(), 500);
          stream.on("end", () => {
            streamEnded = true;
            clearTimeout(timer);
            resolve();
          });
          stream.on("error", () => {
            clearTimeout(timer);
            resolve();
          });
          stream.resume();
        });

        // If stream didn't end, poll exec.inspect until ExitCode is set.
        if (!streamEnded) {
          stream.destroy();
          const pollDeadline = Date.now() + 1000;
          while (Date.now() < pollDeadline) {
            const info = await exec.inspect();
            if (info.ExitCode !== null) break;
            await new Promise((r) => setTimeout(r, 30));
          }
        }

        const inspectResult = await exec.inspect();
        if (inspectResult.ExitCode === 0) {
          return; // Socket exists
        }
        lastError = `test -S exited ${inspectResult.ExitCode}`;
      } catch (err) {
        lastError =
          err instanceof Error ? err.message : "exec failed (unknown)";
      }

      await new Promise((r) => setTimeout(r, backoffs[attempt]));
    }

    // Collect container logs for diagnostics
    let containerLogs = "";
    try {
      const logBuf = await container.logs({
        stdout: true,
        stderr: true,
        tail: 20,
      });
      containerLogs = Buffer.isBuffer(logBuf)
        ? logBuf.toString("utf8")
        : String(logBuf);
    } catch {
      /* best-effort */
    }

    throw new Error(
      `Timeout waiting for proxy socket: ${socketPath} ` +
        `(last: ${lastError ?? "no attempts"}, ` +
        `elapsed: ${Date.now() - start}ms)\n` +
        `Container logs:\n${containerLogs}`
    );
  }
}
