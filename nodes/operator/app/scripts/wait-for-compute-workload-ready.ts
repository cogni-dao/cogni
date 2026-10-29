// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

import { safeVersionProbeResult } from "../src/adapters/server/compute/safe-version-probe.ts";
import { assessComputeWorkloadReadiness } from "../src/features/compute/compute-workload-readiness.ts";

const execFileAsync = promisify(execFile);
const options = {
  "manifest-json": { type: "string" },
  host: { type: "string" },
  identity: { type: "string" },
  "public-only": { type: "boolean", default: false },
  "timeout-seconds": { type: "string", default: "900" },
} as const;

/**
 * The controller's own allocation budget bounds this wait: one provider attempt
 * is bidTimeout (90s) + bootSlo (300s) before the on-chain tx, DNS reconcile and
 * source verify, and it retries up to maxProviderAttempts. A ceiling below that
 * turns a converging deploy into a hard red before the buildSha proof can run.
 */
const MAX_TIMEOUT_SECONDS = 1_800;

export async function main(): Promise<void> {
  const { values } = parseArgs({ options, strict: true });
  const manifestPath = required(values["manifest-json"], "--manifest-json");
  const publicOnly = values["public-only"];
  // Foreign custody cannot grant this candidate job control-plane credentials.
  // Its existing public revision authority needs neither an SSH host nor a key.
  const host = publicOnly ? undefined : required(values.host, "--host");
  const identity = publicOnly
    ? undefined
    : required(values.identity, "--identity");
  if (host) validateHost(host);
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
  const versionTarget = publicVersionTarget(expected);
  if (publicOnly && !versionTarget) {
    throw new Error("--public-only requires manifest spec.workload.publicHost");
  }
  // ONE_AUTHORITY_PER_WORKLOAD: the manifest's kind names the resource to poll —
  // Crossplane composites are `xcomputeworkload`, the legacy CR `computeworkload`.
  const resource =
    record(expected)?.kind === "XComputeWorkload"
      ? "xcomputeworkload"
      : "computeworkload";
  const deadline = Date.now() + timeoutSeconds * 1_000;
  let lastReason = "not_yet_polled";

  while (Date.now() < deadline) {
    // The externally-served /version.buildSha is ground truth (watch-gate
    // <truth>; promote-green-not-proof): a deploy has landed when the public host
    // serves the expected SHA. It is probed every iteration, independent of the
    // control-plane read, so an SSH read_timeout or an XR status that lags the
    // served artifact cannot fail a run that already serves the target (bug.5555).
    // This reads a STRONGER signal than the control plane; it does not loosen the gate.
    let publicReason: string | undefined;
    if (versionTarget) {
      const publicRemainingMs = deadline - Date.now();
      if (publicRemainingMs > 0) {
        const version = await probePublicVersion(
          versionTarget,
          Math.min(5_000, publicRemainingMs)
        );
        if (version === "matched") {
          process.stdout.write(
            `[compute-workload-ready] ${namespace}/${name} Public revision verified; public buildSha=${versionTarget.sourceSha}\n`
          );
          return;
        }
        publicReason = `public_${version}`;
      } else {
        publicReason = "public_version_unavailable";
      }
    }
    // The control-plane read stays authoritative for workloads WITHOUT a public
    // host, and names the failure owner (resource_absent, ...) on timeout.
    const observation = publicOnly
      ? undefined
      : await readLiveWorkload({
          host: required(host, "--host"),
          identity: required(identity, "--identity"),
          namespace,
          name,
          resource,
          timeoutMs: Math.max(1, Math.min(40_000, deadline - Date.now())),
        });
    if (!observation) {
      lastReason = publicReason ?? lastReason;
    } else if (observation.ok) {
      const assessment = assessComputeWorkloadReadiness({
        expected,
        live: observation.resource,
      });
      if (!assessment.ready) {
        lastReason = assessment.reason;
      } else if (!versionTarget) {
        process.stdout.write(
          `[compute-workload-ready] ${namespace}/${name} Ready at current generation\n`
        );
        return;
      } else {
        // Controller Ready, but the public host has not yet proven the SHA.
        lastReason = publicReason ?? "public_version_unavailable";
      }
    } else {
      // A control-plane-origin reason is more informative than a public symptom.
      lastReason = observation.reason;
    }
    process.stdout.write(
      `[compute-workload-ready] ${namespace}/${name} ${lastReason}; waiting\n`
    );
    const remainingMs = deadline - Date.now();
    if (remainingMs > 0) await delay(Math.min(5_000, remainingMs));
  }
  const hint = timeoutHint(lastReason);
  throw new Error(
    `[compute-workload-ready] timed out for ${namespace}/${name}: ${lastReason}${
      hint ? ` - ${hint}` : ""
    }`
  );
}

function publicVersionTarget(
  expected: unknown
): { readonly endpoint: string; readonly sourceSha: string } | undefined {
  const spec = record(record(expected)?.spec);
  const publicHost = record(spec?.workload)?.publicHost;
  // Workloads without a public surface retain their controller-only gate.
  if (publicHost === undefined) return undefined;
  if (
    typeof publicHost !== "string" ||
    publicHost.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(
      publicHost
    ) ||
    isIP(publicHost) !== 0 ||
    publicHost.toLowerCase().endsWith(".local")
  ) {
    throw new Error(
      "manifest spec.workload.publicHost must be a public DNS hostname"
    );
  }
  const sourceSha = record(record(spec?.bundle)?.source)?.sha;
  if (typeof sourceSha !== "string" || !/^[a-f0-9]{40}$/.test(sourceSha)) {
    throw new Error(
      "manifest spec.bundle.source.sha must be a full commit SHA for a public workload"
    );
  }
  return { endpoint: `https://${publicHost}`, sourceSha };
}

async function probePublicVersion(
  target: { readonly endpoint: string; readonly sourceSha: string },
  timeoutMs: number
): Promise<"matched" | "source_mismatch" | "version_unavailable"> {
  // Also bound DNS resolution, which precedes the helper's socket timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      safeVersionProbeResult(target.endpoint, target.sourceSha, timeoutMs),
      new Promise<"version_unavailable">((resolve) => {
        timer = setTimeout(() => resolve("version_unavailable"), timeoutMs);
      }),
    ]);
  } catch {
    return "version_unavailable";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A timeout must name the OWNER of the failure, not just the last symptom. These reasons
 * look alike in a log and have completely different fixes: an absent resource is a
 * desired-state/Argo problem that waiting can NEVER resolve, while a bundle mismatch is the
 * actuator still working. poly spent a week being "waited on" for the first while everyone
 * read it as the second (bug.5262).
 */
function timeoutHint(reason: string): string {
  if (reason.startsWith("bundle_not_observed")) {
    return "the workload EXISTS but has not observed the desired bundle - the actuator has not applied this revision";
  }
  // A latched phase and a dead lease are opposite problems wearing the same word.
  if (reason.startsWith("phase_not_ready")) {
    return reason.includes("serving=true")
      ? "the composite IS serving and the desired bundle already matched, so this phase is most likely LATCHED from a prior generation - verify /version.buildSha against the desired sha before treating this as an outage"
      : "the composite is NOT serving - this is a real lease/boot problem, not a latched phase";
  }
  const hints: Readonly<Record<string, string>> = {
    resource_absent:
      "the workload DOES NOT EXIST in this namespace - Git declares it but Argo has not applied it, so waiting can never succeed; inspect the per-node Application sync state",
    read_forbidden: "the gate's credential may not read this resource",
    control_plane_unreachable: "the control-plane host did not answer",
    read_timeout: "the control-plane read timed out",
    public_source_mismatch:
      "the canonical public host still serves a different source SHA",
    public_version_unavailable:
      "the canonical public host has not provided exact source proof",
  };
  return hints[reason] ?? "";
}

async function readLiveWorkload(input: {
  readonly host: string;
  readonly identity: string;
  readonly namespace: string;
  readonly name: string;
  readonly resource: string;
  readonly timeoutMs: number;
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
      { timeout: input.timeoutMs, maxBuffer: 2 * 1024 * 1024 }
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
  if (/\bnot found\b/i.test(stderr)) return "resource_absent";
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

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "unknown error"}\n`
    );
    process.exitCode = 1;
  });
}
