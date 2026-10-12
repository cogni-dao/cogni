#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/temporal-schedule-proof`
 * Purpose: Prove create -> terminal graph run -> delete for Poly and node-template.
 * Scope: Uses public node APIs and read-only Loki queries only.
 * Invariants: Fixed two-target order, ephemeral actors, free-model probe, no secrets in output.
 * Side-effects: IO (actor registration, temporary schedules, Grafana reads)
 * Links: task.5239, scripts/lib/temporal-scheduled-probe.mjs
 * @public
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parse as parseYaml } from "yaml";

import { createTemporalLokiEvidenceReader } from "./lib/temporal-loki-evidence.mjs";
import { proveScheduledLangGraphTargets } from "./lib/temporal-scheduled-probe.mjs";

const TARGET_NAMES = ["poly", "node-template"];
const ENVIRONMENTS = new Set(["candidate-a", "preview", "production"]);

function trimUrl(value) {
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("target URL must use http or https");
  }
  return parsed.origin;
}

function defaultBaseUrl(name, environment) {
  if (environment === "candidate-a") {
    return `https://${name}-test.cognidao.org`;
  }
  if (environment === "preview") {
    return `https://${name}-preview.cognidao.org`;
  }
  return `https://${name}.cognidao.org`;
}

export function parseScheduleProofArgs(argv) {
  const result = { environment: "candidate-a", urls: {} };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--env") {
      result.environment = argv[++index];
    } else if (arg === "--poly-url") {
      result.urls.poly = argv[++index];
    } else if (arg === "--node-template-url") {
      result.urls["node-template"] = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!ENVIRONMENTS.has(result.environment)) {
    throw new Error("--env must be candidate-a, preview, or production");
  }
  return result;
}

export function resolveScheduleProofTargets({ repoRoot, environment, urls }) {
  return TARGET_NAMES.map((name) => {
    const catalogPath = path.join(repoRoot, "infra", "catalog", `${name}.yaml`);
    const row = parseYaml(fs.readFileSync(catalogPath, "utf8"));
    if (
      typeof row?.node_id !== "string" ||
      !Array.isArray(row?.envs) ||
      !row.envs.includes(environment)
    ) {
      throw new Error(`${name} is not declared for ${environment}`);
    }
    const workerEnvironment =
      row?.deployment_provider?.[environment] === "akash" &&
      environment !== "production"
        ? "production"
        : environment;
    return {
      name,
      nodeId: row.node_id,
      environment,
      workerEnvironment,
      baseUrl: trimUrl(urls[name] ?? defaultBaseUrl(name, environment)),
    };
  });
}

export async function registerScheduleProofActor(
  target,
  options = {},
  dependencies = {}
) {
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const nonce = dependencies.nonce ?? (() => randomUUID().slice(0, 8));
  const now = dependencies.now ?? Date.now;
  const response = await fetchImpl(`${target.baseUrl}/api/v1/agent/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: `temporal-schedule-proof-${target.name}-${now()}-${nonce()}`,
    }),
    signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
  });
  if (!response?.ok) {
    throw new Error(
      `${target.name} actor registration failed with HTTP ${response?.status ?? "unknown"}`
    );
  }
  const body = await response.json();
  if (typeof body?.apiKey !== "string" || body.apiKey.length === 0) {
    throw new Error(`${target.name} actor registration returned no apiKey`);
  }
  return body.apiKey;
}

function print(write, value) {
  write(`${JSON.stringify(value, null, 2)}\n`);
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const write = dependencies.write ?? ((value) => process.stdout.write(value));
  let args;
  try {
    args = parseScheduleProofArgs(argv);
  } catch (error) {
    print(write, {
      status: "error",
      phase: "arguments",
      message: error instanceof Error ? error.message : "invalid arguments",
    });
    return 2;
  }
  if (args.help) {
    write(
      "Usage: pnpm temporal:schedule-proof [--env candidate-a|preview|production] [--poly-url URL] [--node-template-url URL]\n"
    );
    return 0;
  }

  try {
    const targets =
      dependencies.targets ??
      resolveScheduleProofTargets({
        repoRoot: dependencies.repoRoot ?? process.cwd(),
        environment: args.environment,
        urls: args.urls,
      });
    const readLokiEvidence =
      dependencies.readLokiEvidence ??
      (dependencies.createLokiReader ?? createTemporalLokiEvidenceReader)();
    const registerActor =
      dependencies.registerActor ?? registerScheduleProofActor;
    const authenticated = [];
    for (const target of targets) {
      const apiKey = await registerActor(target);
      authenticated.push({ ...target, apiKey });
    }
    const results = await (
      dependencies.runTargets ?? proveScheduledLangGraphTargets
    )(authenticated, { readLokiEvidence });
    print(write, { status: "proven", environment: args.environment, results });
    return 0;
  } catch (error) {
    print(write, {
      status: "error",
      phase: error?.phase ?? "schedule_proof",
      message: error instanceof Error ? error.message : "schedule proof failed",
    });
    return 1;
  }
}

if (
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
) {
  process.exitCode = await main();
}
