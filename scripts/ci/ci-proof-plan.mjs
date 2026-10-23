// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/ci-proof-plan`
 * Purpose: Select declared native CI proof from an event-base policy and verify terminal gates.
 * Scope: Git objects and workflow result metadata only. Does not access network, deployment or credentials.
 * Invariants: UNKNOWN_MEANS_FULL; TRUSTED_EXEMPTION_POLICY; REQUIRED_PROOF_FAILS_CLOSED.
 * Side-effects: IO (appends audited GitHub output and summary files).
 * Notes: Standalone stdlib module so workflows can execute exact event-base bytes from a temp file.
 * Links: task.5314, .github/workflows/ci.yaml, .github/workflows/pr-build.yml
 * @internal
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const env = process.env;
const policyPath = "scripts/ci/ci-proof-plan.mjs";
// Exemptions are disabled until a fresh review certifies the complete native
// executable/filesystem/install lifecycle closure. The previous native-tree +
// config audit could go stale after a merged shell helper gained an app input.
// No environment variable or PR-provided certificate can enable a skip.
const isSha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
const git = (...args) =>
  execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 32 * 1024 * 1024,
  });
function requireThat(condition, message) {
  if (!condition) throw new Error(message);
}
function success(key) {
  requireThat(
    env[key] === "success",
    `${key} must succeed (got '${env[key] ?? ""}')`
  );
}

function plan() {
  const base = env.EVENT_BASE_SHA ?? "";
  const head = env.EVENT_HEAD_SHA ?? "";
  const result = {
    plan_version: "1",
    native_required: "true",
    reason: "full-event",
    policy_sha: env.POLICY_SHA ?? "",
    base_sha: base,
    head_sha: head,
    native_config: "unavailable",
  };
  if (env.CI_EVENT !== "pull_request") return result;
  if (env.EVENT_BASE_REF !== "main")
    return { ...result, reason: "non-main-target" };
  try {
    requireThat(isSha(base) && isSha(head), "unresolved-event-identity");
    requireThat(env.POLICY_SHA === base, "policy-provenance-mismatch");
    requireThat(
      git("rev-parse", `${base}^{commit}`).trim() === base &&
        git("rev-parse", `${head}^{commit}`).trim() === head,
      "unresolved-event-objects"
    );
    requireThat(
      git("show", `${base}:${policyPath}`) ===
        readFileSync(fileURLToPath(import.meta.url), "utf8"),
      "policy-bytes-mismatch"
    );
    return {
      ...result,
      reason: "native-exemptions-disabled-pending-transitive-audit",
    };
  } catch (error) {
    return {
      ...result,
      reason: error.message.startsWith("Command failed:")
        ? "missing-or-unresolved-policy-input"
        : error.message,
    };
  }
}

function verifyUnit() {
  for (const key of ["CLASSIFIER_RESULT", "CORE_RESULT", "SHELL_RESULT"])
    success(key);
  requireThat(env.PLAN_VERSION === "1", "missing/unsupported plan version");
  requireThat(
    ["true", "false"].includes(env.NATIVE_REQUIRED),
    "missing/malformed native decision"
  );
  requireThat(isSha(env.POLICY_SHA), "missing policy identity");
  requireThat(
    env.PLAN_BASE_SHA === env.EVENT_BASE_SHA &&
      env.PLAN_HEAD_SHA === env.EVENT_HEAD_SHA,
    "plan/event identity mismatch"
  );
  if (env.EVENT_BASE_SHA)
    requireThat(
      env.POLICY_SHA === env.EVENT_BASE_SHA,
      "policy/event-base mismatch"
    );
  // Even an older trusted event-base planner returning false cannot permit a
  // native skip in the current graph. Missing, failed and cancelled native
  // proof remains red while exemptions are disabled.
  success("NATIVE_RESULT");
}

function verifyManifest() {
  success("RESOLVE_RESULT");
  success("DETECT_RESULT");
  requireThat(
    isSha(env.SOURCE_SHA) && env.IMAGE_TAG === `sha-${env.SOURCE_SHA}`,
    "missing/incoherent source SHA and image tag"
  );
  const targets = JSON.parse(env.TARGETS_JSON ?? "null");
  requireThat(
    Array.isArray(targets) &&
      targets.every(
        (target) =>
          typeof target === "string" && /^[a-z0-9][a-z0-9-]*$/.test(target)
      ) &&
      new Set(targets).size === targets.length,
    "malformed target plan"
  );
  requireThat(
    ["true", "false"].includes(env.HAS_TARGETS) &&
      (env.HAS_TARGETS === "true") === targets.length > 0,
    "incoherent target plan"
  );
  if (env.HAS_TARGETS === "true") success("BUILD_RESULT");
  else
    requireThat(
      ["success", "skipped"].includes(env.BUILD_RESULT),
      "no-target build failed/cancelled"
    );
}

try {
  switch (process.argv[2]) {
    case "plan": {
      const result = plan();
      console.log(JSON.stringify(result));
      if (env.GITHUB_OUTPUT)
        appendFileSync(
          env.GITHUB_OUTPUT,
          Object.entries(result)
            .map(([key, value]) => `${key}=${value}\n`)
            .join("")
        );
      if (env.GITHUB_STEP_SUMMARY)
        appendFileSync(
          env.GITHUB_STEP_SUMMARY,
          `### Native proof plan\n\n${Object.entries(result)
            .map(([key, value]) => `- ${key}: \`${value}\``)
            .join("\n")}\n`
        );
      break;
    }
    case "verify-unit":
      verifyUnit();
      break;
    case "verify-component":
      success("COMPONENT_RESULT");
      success("MIGRATOR_RESULT");
      break;
    case "verify-manifest":
      verifyManifest();
      break;
    default:
      throw new Error(
        "expected plan, verify-unit, verify-component or verify-manifest"
      );
  }
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
