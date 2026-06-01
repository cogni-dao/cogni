// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/sandbox-runner`
 * Purpose: Port interface for network-isolated sandbox command execution.
 * Scope: Defines contract for one-shot container execution. Does not implement execution logic.
 * Invariants:
 *   - Per SANDBOXED_AGENTS.md P0: One-shot containers, no long-lived sessions
 *   - Per NETWORK_DEFAULT_DENY: Container runs with network=none by default
 *   - Per SECRETS_HOST_ONLY: No tokens/credentials passed to sandbox
 * Side-effects: none (interface definition only)
 * Links: docs/spec/sandboxed-agents.md
 * @public
 */

/**
 * Mount specification for binding host paths into the container.
 */
export interface SandboxMount {
  /** Host filesystem path to mount */
  readonly hostPath: string;
  /** Path inside container where mount appears */
  readonly containerPath: string;
  /** Mount mode: 'ro' for read-only, 'rw' for read-write */
  readonly mode: "ro" | "rw";
}

/**
 * Named Docker volume mount for sandbox containers.
 * Used for git-sync repo volumes, shared caches, or artifact volumes.
 * Defaults to read-only — callers must explicitly opt into read-write.
 */
export interface SandboxVolumeMount {
  /** Docker named volume (e.g., "repo_data") */
  readonly volume: string;
  /** Path inside container (e.g., "/repo") */
  readonly containerPath: string;
  /** Defaults to true. Force explicit override if ever needed. */
  readonly readOnly?: boolean;
}

/**
 * Network mode configuration for sandbox containers.
 */
export interface SandboxNetworkMode {
  /**
   * Network mode for container execution.
   * - 'none' (default): Complete network isolation (P0 baseline)
   * - 'internal': Attach to named internal network (P0.5a spike only)
   */
  readonly mode: "none" | "internal";
  /** Required when mode='internal'. Must be a Docker network with internal:true */
  readonly networkName?: string;
}

/**
 * LLM proxy configuration for sandbox containers.
 * Per SANDBOXED_AGENTS.md P0.5: Enables LLM access via unix socket bridge.
 */
export interface SandboxLlmProxyConfig {
  /** Enable LLM proxy for this run */
  readonly enabled: true;
  /** Billing account ID for cost attribution. Injected as x-litellm-end-user-id. */
  readonly billingAccountId: string;
  /** Run attempt number for billing attribution (goes in metadata, not end-user-id) */
  readonly attempt: number;
  /** Additional environment variables to set in container */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Specification for a single sandbox command execution.
 */
export interface SandboxRunSpec {
  /** Unique run ID for correlation and logging */
  readonly runId: string;
  /** Host filesystem path to mount as /workspace in container */
  readonly workspacePath: string;
  /** Docker image to use for this run. */
  readonly image: string;
  /**
   * Command arguments to execute.
   * For shell commands, use: ['bash', '-lc', 'your command here']
   * For direct binaries, use: ['/usr/bin/node', 'script.js']
   */
  readonly argv: readonly string[];
  /** Resource limits for the container */
  readonly limits: {
    /** Maximum runtime in seconds before timeout */
    readonly maxRuntimeSec: number;
    /** Maximum memory in megabytes */
    readonly maxMemoryMb: number;
    /** Maximum combined stdout+stderr bytes (default: 2MB) */
    readonly maxOutputBytes?: number;
  };
  /** Additional bind mounts (e.g., host paths) */
  readonly mounts?: readonly SandboxMount[];
  /** Named Docker volume mounts (e.g., git-sync repo_data at /repo:ro) */
  readonly volumes?: readonly SandboxVolumeMount[];
  /**
   * Network mode for container. Defaults to { mode: 'none' } for complete isolation.
   * Note: P0.5 uses network=none + llmProxy for LLM access, not internal network.
   */
  readonly networkMode?: SandboxNetworkMode;
  /**
   * LLM proxy configuration. When enabled, starts a host-side proxy and mounts
   * the socket into the container. Sets OPENAI_API_BASE=http://localhost:8080.
   * Per SANDBOXED_AGENTS.md P0.5: Enables LLM access while maintaining network=none.
   */
  readonly llmProxy?: SandboxLlmProxyConfig;
}

/**
 * Error codes for sandbox execution failures.
 */
export type SandboxErrorCode =
  | "timeout"
  | "oom_killed"
  | "internal"
  | "container_failed"
  | "output_truncated";

/**
 * A single billing entry extracted from the proxy audit log.
 * Mirrors the inproc flow where the host-side LiteLLM adapter captures
 * response headers (x-litellm-call-id, x-litellm-response-cost).
 */
export interface ProxyBillingEntry {
  /** LiteLLM call ID from x-litellm-call-id response header (usageUnitId) */
  readonly litellmCallId: string;
  /** Provider cost in USD from x-litellm-response-cost response header */
  readonly costUsd?: number;
}

/**
 * Result of a sandbox command execution.
 */
export interface SandboxRunResult {
  /** True if command exited with code 0 */
  readonly ok: boolean;
  /** Standard output from the command */
  readonly stdout: string;
  /** Standard error from the command */
  readonly stderr: string;
  /** Exit code from the command */
  readonly exitCode: number;
  /** Error code if execution failed (timeout, OOM, etc.) */
  readonly errorCode?: SandboxErrorCode;
  /** True if output was truncated due to size limits */
  readonly outputTruncated?: boolean;
  /**
   * Billing entries extracted from the proxy audit log (host-side).
   * One entry per LLM call made through the proxy.
   * Present only when llmProxy was enabled.
   */
  readonly proxyBillingEntries?: readonly ProxyBillingEntry[];
}

/**
 * Stdout contract for sandbox programs (agents, tools).
 *
 * Every program that runs inside a sandbox container writes exactly one
 * JSON object to stdout conforming to this shape. The host-side
 * SandboxGraphProvider parses this envelope — it never inspects raw text.
 *
 * Matches OpenClaw `--json` output so the provider is agent-agnostic:
 * swapping run.mjs for OpenClaw requires zero provider changes.
 */
export interface SandboxProgramContract {
  /** Response payloads. Typically one entry with the LLM response text. */
  readonly payloads: ReadonlyArray<{ readonly text: string }>;
  /** Execution metadata. */
  readonly meta: {
    /** Wall-clock duration inside the container (ms). */
    readonly durationMs: number;
    /** Null on success; structured error on failure. */
    readonly error: {
      readonly code: string;
      readonly message: string;
    } | null;
    /** LiteLLM call ID from x-litellm-call-id response header (for billing usageUnitId). */
    readonly litellmCallId?: string;
  };
}

/**
 * Port interface for sandbox command execution.
 *
 * Per SANDBOXED_AGENTS.md P0: Containers are ephemeral and one-shot.
 * Each `runOnce` call creates a new container, runs the command, and removes it.
 *
 * The container runs with network=none for isolation by default.
 * Host mounts workspace directory for file I/O.
 */
export interface SandboxRunnerPort {
  /**
   * Execute a single command in an isolated container.
   *
   * Flow: create container → start → run command → collect output → remove
   *
   * @param spec - Command specification with workspace path and limits
   * @returns Promise resolving to execution result with stdout/stderr
   */
  runOnce(spec: SandboxRunSpec): Promise<SandboxRunResult>;
}
