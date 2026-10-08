// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/webhook-sync-fails-loud`
 * Purpose: Prove the GitHub App webhook-secret sync never exits without naming a cause, and that a credential GitHub rejects skips instead of failing the whole deploy.
 * Scope: Runs the real `scripts/secrets/sync-app-webhook-secret.sh` against a PATH-injected `curl` shim; does not reach GitHub and does not PATCH any App.
 * Invariants:
 *   - NO_SILENT_EXIT: every non-success path prints a line naming the endpoint and the status.
 *   - REJECTED_CREDS_SKIP: a 401/403 on `GET /app` exits 0 loudly — a creds fault is not this sync's blast radius.
 *   - OTHER_FAILURES_STILL_FAIL: a 5xx or a transport failure still exits non-zero.
 * Side-effects: IO (mktemp sandbox; spawns bash)
 * Links: bug.5404, bug.5117
 * @public
 *
 * WHY THIS EXISTS. Two faults, one file, both measured on 2026-10-08.
 *
 * (1) SILENT EXIT. `x="$(curl -fsS … 2>/dev/null | sed …)"` under `set -euo pipefail` aborts AT
 * THE ASSIGNMENT, so the `|| { err "FATAL …"; exit 1; }` on the next line never runs. A rejected
 * App JWT exited 56 with ZERO output and `deploy-infra`'s fail-closed webhook guard could report
 * only that it had closed, never why.
 *
 * (2) DISPROPORTIONATE BLAST RADIUS. Once it could speak, it said `GET /app` → 401: candidate-a's
 * App key was rotated in the GitHub environment bank on 10-03 while OpenBao kept the superseded
 * copy. One dead test-environment credential was failing EVERY compose-lane infra deploy,
 * including unrelated Grafana datasource provisioning (bug.5117). The cross-env guard had already
 * settled the principle for a mispointed credential — skip loudly, "this sync must never be the
 * blast radius" — and a rejected credential is the same class of fault.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(
  REPO_ROOT,
  "scripts/secrets/sync-app-webhook-secret.sh"
);

/**
 * A `curl` that answers every request with a canned HTTP status, honouring the
 * `-o <file>` / `-w '%{http_code}'` contract the script relies on.
 */
const CURL_SHIM = [
  "#!/usr/bin/env bash",
  "out=''",
  "while (( $# > 0 )); do",
  '  case "$1" in',
  '    -o) out="$2"; shift 2 ;;',
  "    *) shift ;;",
  "  esac",
  "done",
  'if [[ "${SHIM_TRANSPORT_FAIL:-0}" == "1" ]]; then',
  '  echo "curl: (7) Failed to connect to api.github.com port 443" >&2',
  "  exit 7",
  "fi",
  'body="{\\"slug\\":\\"shim-app\\",\\"url\\":\\"https://shim.example/hook\\"}"',
  '[[ -n "$out" ]] && printf \'%s\' "$body" > "$out"',
  "printf '%s' \"${SHIM_HTTP_STATUS:-200}\"",
  "",
].join("\n");

function run(extraEnv: Record<string, string>): {
  readonly status: number;
  readonly out: string;
} {
  const root = mkdtempSync(path.join(tmpdir(), "webhook-sync-"));
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const shim = path.join(bin, "curl");
  writeFileSync(shim, CURL_SHIM);
  chmodSync(shim, 0o755);

  const key = execFileSync("openssl", ["genrsa", "2048"], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  // spawnSync, not execFileSync: this script reports through `err()` on STDERR,
  // and execFileSync only hands back stderr when the command FAILS. A skip-path
  // assertion (exit 0 + a loud line) would then read an empty string and fail
  // for the wrong reason.
  const proc = spawnSync("bash", [SCRIPT], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GH_REVIEW_APP_ID: "123456",
      GH_REVIEW_APP_PRIVATE_KEY_BASE64: key.toString("base64"),
      GH_WEBHOOK_SECRET: "dummy-not-a-real-secret",
      ...extraEnv,
    },
  });
  return {
    status: proc.status ?? 1,
    out: `${proc.stdout ?? ""}${proc.stderr ?? ""}`,
  };
}

describe("sync-app-webhook-secret (bug.5404)", () => {
  it("REJECTED_CREDS_SKIP: a 401 on GET /app skips loudly instead of failing the deploy", () => {
    const result = run({ SHIM_HTTP_STATUS: "401" });

    expect(result.status).toBe(0);
    expect(result.out).toContain("REFUSING");
    expect(result.out).toContain("401");
  });

  it("REJECTED_CREDS_SKIP: a 403 is treated the same way", () => {
    expect(run({ SHIM_HTTP_STATUS: "403" }).status).toBe(0);
  });

  it("OTHER_FAILURES_STILL_FAIL: a 500 exits non-zero and names the status", () => {
    const result = run({ SHIM_HTTP_STATUS: "500" });

    expect(result.status).not.toBe(0);
    expect(result.out).toContain("FATAL");
    expect(result.out).toContain("500");
  });

  it("NO_SILENT_EXIT: a transport failure exits non-zero and says so", () => {
    const result = run({ SHIM_TRANSPORT_FAIL: "1" });

    expect(result.status).not.toBe(0);
    expect(result.out).toContain("transport failure");
  });
});
