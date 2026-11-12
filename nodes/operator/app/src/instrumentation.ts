// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Next compiles this entry for Node and Edge; load native telemetry only in Node. */
import type { NodeSDK } from "@opentelemetry/sdk-node";

let nodeInstrumentation: typeof import("./instrumentation.node") | null = null;

export async function initOtelSdk(options?: {
  failOnError?: boolean;
}): Promise<boolean> {
  // biome-ignore lint/style/noProcessEnv: Next replaces NEXT_RUNTIME at compilation
  if (process.env.NEXT_RUNTIME !== "edge") {
    nodeInstrumentation ??= await import("./instrumentation.node");
    return nodeInstrumentation.initOtelSdk(options);
  }
  return false;
}

export async function register(): Promise<void> {
  // biome-ignore lint/style/noProcessEnv: Next replaces NEXT_RUNTIME at compilation
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (!nodeInstrumentation) {
      try {
        nodeInstrumentation = await import("./instrumentation.node");
      } catch (error) {
        try {
          // The node logger cannot be imported when this import itself fails.
          // biome-ignore lint/suspicious/noConsole: bounded fatal bootstrap diagnostic
          console.error(
            JSON.stringify({
              errorCode: "STARTUP_FATAL",
              phase: "instrumentation_import",
            }),
          );
        } catch {
          // Preserve fatality and the original import rejection.
        }
        process.exit(1);
        throw error;
      }
    }
    await nodeInstrumentation.register();
  }
}

export function getOtelSdk(): NodeSDK | null {
  return nodeInstrumentation?.getOtelSdk() ?? null;
}
