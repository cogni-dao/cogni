// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { parseArgs, promisify } from "node:util";

import { assessComputeWorkloadReadiness } from "../src/features/compute/compute-workload-readiness.ts";

const execFileAsync = promisify(execFile);
const options = {
  "manifest-json": { type: "string" },
  host: { type: "string" },
  identity: { type: "string" },
  "timeout-seconds": { type: "string", default: "900" },
} as const;

/**
 * The controller's own allocation budget bounds this wait: one provider attempt
 * is bidTimeout (90s) + bootSlo (300s) before the on-chain tx, DNS reconcile and
 * source verify, and it retries up to maxProviderAttempts. A ceiling below that
 * turns a converging deploy into a hard red before the buildSha proof can run.
 */
const MAX_TIMEOUT_SECONDS = 1_800;

async function main(): Promise<void> {
  const { values } = parseArgs({ options, strict: true });
  const manifestPath = required(values["manifest-json"], "--manifest-json");
  const host = required(values.host, "--host");
  const identity = required(values.identity, "--identity");
  validateHost(host);
  const timeoutSeconds = Number(values["timeout-seconds"]);
  if (
    !Number.isInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `--timeout-seconds must be an integer between 1 and ${MAX_TIMEOUT_SECONDS}`
    );
  }

  const expected = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  const metadata = record(record(expected)?.metadata);
  const name = requiredString(metadata?.name, "manifest metadata.name");
  const namespace = requiredString(
    metadata?.namespace,
    "manifest metadata.namespace"
  );
  validateResourceName(name);
  validateNamespace(namespace);
  // ONE_AUTHORITY_PER_WORKLOAD: the manifest's kind names the resource to poll —
  // Crossplane composites are `xcomputeworkload`, the legacy CR `computeworkload`.
  const resource =
    record(expected)?.kind === "XComputeWorkload"
      ? "xcomputeworkload"
      : "computeworkload";
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let lastReason = "not_observed";

  while (Date.now() < deadline) {
    const observation = await readLiveWorkload({
      host,
      identity,
      namespace,
      name,
      resource,
    });
    if (observation.ok) {
      const assessment = assessComputeWorkloadReadiness({
        expected,
        live: observation.resource,
      });
      if (assessment.ready) {
        process.stdout.write(
          `[compute-workload-ready] ${namespace}/${name} Ready at current generation\n`
        );
        return;
      }
      lastReason = assessment.reason;
    } else {
      lastReason = observation.reason;
    }
    process.stdout.write(
      `[compute-workload-ready] ${namespace}/${name} ${lastReason}; waiting\n`
    );
    await delay(5_000);
  }
  throw new Error(
    `[compute-workload-ready] timed out for ${namespace}/${name}: ${lastReason}`
  );
}

async function readLiveWorkload(input: {
  readonly host: string;
  readonly identity: string;
  readonly namespace: string;
  readonly name: string;
  readonly resource: string;
}): Promise<
  | { readonly ok: true; readonly resource: unknown }
  | { readonly ok: false; readonly reason: string }
> {
  try {
    const { stdout } = await execFileAsync(
      "ssh",
      [
        "-i",
        input.identity,
        "-o",
        "StrictHostKeyChecking=accept-new",
        "-o",
        "ConnectTimeout=30",
        `root@${input.host}`,
        "kubectl",
        "-n",
        input.namespace,
        "get",
        input.resource,
        input.name,
        "--request-timeout=20s",
        "-o",
        "json",
      ],
      { timeout: 40_000, maxBuffer: 2 * 1024 * 1024 }
    );
    return { ok: true, resource: JSON.parse(stdout) as unknown };
  } catch (error: unknown) {
    return { ok: false, reason: classifyReadFailure(error) };
  }
}

function classifyReadFailure(error: unknown): string {
  const detail = record(error);
  const stderr = typeof detail?.stderr === "string" ? detail.stderr : "";
  if (detail?.killed === true) return "read_timeout";
  if (/\bnot found\b/i.test(stderr)) return "not_observed";
  if (/\bforbidden\b|\bunauthorized\b/i.test(stderr)) return "read_forbidden";
  if (
    /connection (?:refused|reset|timed out)|no route to host|could not resolve hostname|kex_exchange_identification/i.test(
      stderr
    )
  ) {
    return "control_plane_unreachable";
  }
  return "read_failed";
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateHost(value: string): void {
  if (
    value.length > 253 ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(value)
  ) {
    throw new Error("--host must be an IPv4 address or DNS hostname");
  }
}

function validateResourceName(value: string): void {
  if (value.length > 253 || !/^[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/.test(value)) {
    throw new Error(
      "manifest metadata.name must be a Kubernetes DNS subdomain"
    );
  }
}

function validateNamespace(value: string): void {
  if (value.length > 63 || !/^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/.test(value)) {
    throw new Error(
      "manifest metadata.namespace must be a Kubernetes DNS label"
    );
  }
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : "unknown error"}\n`
  );
  process.exitCode = 1;
});
