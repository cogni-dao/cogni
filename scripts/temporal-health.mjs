#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/temporal-health`
 * Purpose: Run the complete shared-worker Temporal proof from one command.
 * Scope: Proves Poly and node-template workflow paths. Does not deploy or promote.
 * Invariants: Exit 0 requires every proof stage; output never contains secrets.
 * Side-effects: IO (remote actor registration, chat run, and temporary schedules)
 * Links: story.5076, task.5238, task.5239
 * @public
 */

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { TEMPORAL_HEALTH_CLI_REASON } from "./lib/temporal-health-client.mjs";
import {
  runTemporalHealthProof,
  temporalProofFailure,
} from "./lib/temporal-proof-orchestrator.mjs";

export function parseTemporalHealthArgs(argv) {
  const result = { environment: undefined, urls: {}, expectedShas: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      result.environment = argv[++index];
    } else if (arg === "--poly-url" || arg === "--url") {
      result.urls.poly = argv[++index];
    } else if (arg === "--node-template-url") {
      result.urls["node-template"] = argv[++index];
    } else if (arg === "--poly-sha") {
      result.expectedShas.poly = argv[++index];
    } else if (arg === "--node-template-sha") {
      result.expectedShas["node-template"] = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (
    result.environment !== undefined &&
    !["candidate-a", "preview", "production"].includes(result.environment)
  ) {
    throw new Error("--env must be candidate-a, preview, or production");
  }
  return result;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let args;
  try {
    args = parseTemporalHealthArgs(argv);
  } catch {
    print({
      status: "error",
      reason: TEMPORAL_HEALTH_CLI_REASON.CLI_INVALID,
      phase: "arguments",
    });
    return 2;
  }

  if (args.help) {
    process.stdout.write(
      "Usage: pnpm temporal:health [--env candidate-a|preview|production] [--poly-url URL] [--node-template-url URL] [--poly-sha SHA] [--node-template-sha SHA]\n"
    );
    return 0;
  }

  try {
    const result = await runTemporalHealthProof(
      {
        repoRoot: process.cwd(),
        environment: args.environment,
        urls: args.urls,
        expectedShas: args.expectedShas,
      },
      dependencies
    );
    print(result);
    return 0;
  } catch (error) {
    const failure = temporalProofFailure(error);
    print(failure);
    return [
      TEMPORAL_HEALTH_CLI_REASON.CLI_INVALID,
      TEMPORAL_HEALTH_CLI_REASON.PROOF_CONFIGURATION_INVALID,
    ].includes(failure.reason)
      ? 2
      : 1;
  }
}

function isMainModule() {
  return (
    process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url
  );
}

if (isMainModule()) {
  process.exitCode = await main();
}
