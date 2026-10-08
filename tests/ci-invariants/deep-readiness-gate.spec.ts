// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/deep-readiness-gate`
 * Purpose: Pin the candidate smoke gate's deep-readiness probe — the thing that makes verify-candidate able to fail on dead substrate (bug.5386).
 * Scope: Executes `check_deep_ready` from scripts/ci/smoke-candidate.sh against a local HTTP server. No cloud IO, no kubectl, no candidate-a.
 * Invariants:
 *   - The smoke lib calls `/readyz?deep=1`, not the fleet-safe default `/readyz`.
 *   - A non-200 deep readiness FAILS the gate (non-zero exit).
 *   - A never-answering endpoint fails on the probe's own timeout rather than hanging the job.
 * Side-effects: IO (binds a loopback HTTP server; spawns bash)
 * Links: scripts/ci/smoke-candidate.sh, .github/workflows/candidate-flight.yml, src/app/(infra)/readyz/route.ts
 * @internal
 */

import { execFile } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../.."
);
const SMOKE_SCRIPT = path.join(REPO_ROOT, "scripts/ci/smoke-candidate.sh");

interface Probe {
  server: http.Server;
  base: string;
  paths: string[];
}

let probe: Probe | undefined;

afterEach(async () => {
  if (probe) {
    const { server } = probe;
    probe = undefined;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/**
 * Start a server that records every requested path and answers readiness with
 * `handler`. `handler` returning `null` means "never answer" — the hang case.
 */
async function startProbe(
  handler: (url: string) => { status: number; body: string } | null
): Promise<Probe> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    const result = handler(req.url ?? "");
    if (result === null) return; // never responds
    res.writeHead(result.status, { "content-type": "application/json" });
    res.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("probe server failed to bind");
  }
  probe = { server, base: `http://127.0.0.1:${address.port}`, paths };
  return probe;
}

/**
 * Run only `check_deep_ready` out of the smoke lib. The script's top level
 * needs the node catalog and a real DOMAIN; the gate behaviour under test is
 * the function, so extract it and call it directly.
 */
async function runCheckDeepReady(
  base: string,
  env: Record<string, string> = {}
): Promise<{ code: number; stdout: string; stderr: string }> {
  const script = `
set -uo pipefail
DEEP_READY_TIMEOUT=\${DEEP_READY_TIMEOUT:-5}
DEEP_READY_ATTEMPTS=\${DEEP_READY_ATTEMPTS:-1}
DEEP_READY_SLEEP=\${DEEP_READY_SLEEP:-0}
eval "$(sed -n '/^check_deep_ready() {/,/^}/p' "${SMOKE_SCRIPT}")"
check_deep_ready operator "${base}"
`;
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", script], {
      env: { ...process.env, ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: e.code ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

describe("candidate smoke gate: deep readiness (bug.5386)", () => {
  it("probes ?deep=1, not the fleet-safe default readiness", async () => {
    const p = await startProbe(() => ({
      status: 200,
      body: '{"status":"healthy"}',
    }));

    const result = await runCheckDeepReady(p.base);

    expect(result.code).toBe(0);
    // The default /readyz is deliberately non-fatal on substrate failures so a
    // blip cannot drain the fleet. Gating on it is what let a node with a dead
    // knowledge plane pass verify-candidate.
    expect(p.paths).toContain("/readyz?deep=1");
    expect(p.paths).not.toContain("/readyz");
  });

  it("FAILS the gate when deep readiness reports unhealthy substrate", async () => {
    const p = await startProbe(() => ({
      status: 503,
      body: '{"status":"error","reason":"INFRA_UNREACHABLE","message":"knowledge store is wedged"}',
    }));

    const result = await runCheckDeepReady(p.base);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("deep readiness failed");
    // The blocking dependency must reach the job log, not just a status code.
    expect(result.stderr).toContain("knowledge store is wedged");
  });

  it("fails on its own timeout when the endpoint never answers", async () => {
    // This is the candidate-a signature: the request is received and simply
    // never completes. A gate without `--max-time` would hang with it.
    const p = await startProbe(() => null);

    const result = await runCheckDeepReady(p.base, {
      DEEP_READY_TIMEOUT: "2",
      DEEP_READY_ATTEMPTS: "1",
    });

    expect(result.code).not.toBe(0);
    // Exactly `000` — curl already emits it on a transport failure, so a
    // second default concatenates into a nonsense `000000` in the job log.
    expect(result.stdout).toMatch(/deep readiness: HTTP 000 \(/);
  }, 20_000);

  it("retries before failing, so a single transient does not fail a flight", async () => {
    let calls = 0;
    const p = await startProbe(() => {
      calls += 1;
      return calls === 1
        ? { status: 503, body: '{"status":"error"}' }
        : { status: 200, body: '{"status":"healthy"}' };
    });

    const result = await runCheckDeepReady(p.base, {
      DEEP_READY_ATTEMPTS: "3",
      DEEP_READY_SLEEP: "0",
    });

    expect(result.code).toBe(0);
    expect(calls).toBe(2);
    expect(p.paths.filter((x) => x === "/readyz?deep=1")).toHaveLength(2);
  });
});
