#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/temporal-health`
 * Purpose: Run the authenticated shared Temporal health diagnostic from one command.
 * Scope: Reads one node health route and prints its evidence. Does not mutate workflows or schedules.
 * Invariants: Exit 0 requires HTTP success and a healthy payload; all unknown or failed states exit nonzero.
 * Side-effects: IO (reads repo spec and environment, performs HTTP request, writes stdout)
 * Links: task.5238, scripts/lib/temporal-health-client.mjs
 * @public
 */

import {
  readTemporalHealth,
  resolveTemporalHealthTarget,
  TEMPORAL_HEALTH_CLI_REASON,
} from "./lib/temporal-health-client.mjs";

function parseArgs(argv) {
  const result = { env: "candidate-a", url: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      result.env = argv[++index];
    } else if (arg === "--url") {
      result.url = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["candidate-a", "preview", "production"].includes(result.env)) {
    throw new Error("--env must be candidate-a, preview, or production");
  }
  return result;
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    print({
      status: "error",
      reason: TEMPORAL_HEALTH_CLI_REASON.CLI_INVALID,
      message: error.message,
    });
    return 2;
  }

  if (args.help) {
    process.stdout.write(
      "Usage: pnpm temporal:health [--env candidate-a|preview|production] [--url https://node.example]\n"
    );
    return 0;
  }

  const apiKey = process.env.COGNI_NODE_API_KEY;
  if (!apiKey) {
    print({
      status: "error",
      reason: TEMPORAL_HEALTH_CLI_REASON.AUTH_MISSING,
      message:
        "COGNI_NODE_API_KEY is required (normally loaded from .env.cogni)",
    });
    return 2;
  }

  let baseUrl;
  try {
    baseUrl = resolveTemporalHealthTarget({
      repoRoot: process.cwd(),
      env: args.env,
      url: args.url,
    });
  } catch (error) {
    print({
      status: "error",
      reason: TEMPORAL_HEALTH_CLI_REASON.TARGET_INVALID,
      message: error.message,
    });
    return 2;
  }

  const result = await readTemporalHealth({ baseUrl, apiKey });
  print(result.body);
  return result.exitCode;
}

process.exitCode = await main();
