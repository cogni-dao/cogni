// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/webhook-sync-fails-loud`
 * Purpose: Prove the GitHub App webhook-secret sync can never exit non-zero without naming a cause.
 * Scope: Runs the real `scripts/secrets/sync-app-webhook-secret.sh` against a PATH-injected failing `curl`; does not reach GitHub and does not PATCH any App.
 * Invariants:
 *   - NO_SILENT_EXIT: a failing GitHub read exits non-zero AND prints a `FATAL` line naming the endpoint.
 *   - CURL_DIAGNOSTIC_SURVIVES: curl's own message reaches the log instead of `2>/dev/null`.
 * Side-effects: IO (mktemp sandbox; spawns bash)
 * Links: bug.5404, bug.5117
 * @public
 *
 * WHY THIS EXISTS. `x="$(curl -fsS … 2>/dev/null | sed …)"` under `set -euo pipefail` aborts AT
 * THE ASSIGNMENT, so the `|| { err "FATAL …"; exit 1; }` on the next line never runs. On
 * 2026-10-08 a rejected App JWT therefore exited 56 with ZERO output, and `deploy-infra`'s
 * fail-closed webhook guard could report only that it had closed — never why. That hard-blocked
 * the candidate-a infra lane undiagnosably, which in turn blocked bug.5117. The shape is easy to
 * reintroduce anywhere in this script, so it is pinned here.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(
  REPO_ROOT,
  "scripts/secrets/sync-app-webhook-secret.sh"
);

/** Runs the script with a `curl` that always fails the way an HTTP 401 does. */
function runWithFailingCurl(): {
  readonly status: number;
  readonly out: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "webhook-sync-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const shim = path.join(bin, "curl");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env bash",
      "# Mimic `curl -f` on an HTTP error: one stderr line, no body, exit 22.",
      'echo "curl: (22) The requested URL returned error: 401" >&2',
      "exit 22",
      "",
    ].join("\n")
  );
  chmodSync(shim, 0o755);

  const key = execFileSync("openssl", ["genrsa", "2048"], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  try {
    const out = execFileSync("bash", [SCRIPT], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        GH_REVIEW_APP_ID: "123456",
        GH_REVIEW_APP_PRIVATE_KEY_BASE64: key.toString("base64"),
        GH_WEBHOOK_SECRET: "dummy-not-a-real-secret",
      },
    });
    return { status: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { status: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

describe("sync-app-webhook-secret fails loud (bug.5404)", () => {
  it("NO_SILENT_EXIT: a failing GitHub read names the endpoint before exiting", () => {
    const result = runWithFailingCurl();

    expect(result.status).not.toBe(0);
    expect(result.out).toContain("FATAL");
    expect(result.out).toContain("/app");
  });

  it("CURL_DIAGNOSTIC_SURVIVES: curl's own message reaches the output", () => {
    expect(runWithFailingCurl().out).toContain("401");
  });
});
