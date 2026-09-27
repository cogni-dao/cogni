// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/secret-materialize-absent-classifier`
 * Purpose: Pins the ABSENT-vs-TRANSPORT-vs-DENIED classification in
 *   `scripts/ci/secret-materialize.sh` `prefetch_path`. This is the exact seam bug.5206
 *   broke (a never-in-prod node's absent `cogni/production/<svc>` read was mis-classified
 *   as a transport failure and hard-failed the candidate flight) and where a naive fix
 *   would REGRESS bug.5159 (treating a transport failure — or a 403 permission-denied — as
 *   an empty bucket, then re-minting/clobbering existing keys).
 * Scope: BEHAVIORAL — extracts the real `prefetch_path` from the script and runs it under
 *   bash with a mocked `bao_exec`/`sleep`, so it tests the shipped code, not a copy.
 * Invariants:
 *   - ABSENT_IS_EMPTY: bao exit 2 that is NOT a 403 (an unborn path) → `{}`, returns 0.
 *   - TRANSPORT_STAYS_FATAL: any other non-zero (ssh 255 / kubectl 1 / OpenBao down) →
 *     retried then fatal (exit 1), never a false-empty (bug.5159).
 *   - DENIED_STAYS_FATAL: bao exit 2 WITH a 403/permission-denied → fatal, never `{}`
 *     (bao exits 2 for both absent and denied — the 403 guard is load-bearing).
 * Side-effects: spawns bash; writes only under a temp CACHE_DIR.
 * Links: scripts/ci/secret-materialize.sh, bug.5206, bug.5159
 * @public
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SCRIPT = path.resolve(
  __dirname,
  "../../scripts/ci/secret-materialize.sh"
);

/** Extract the real `prefetch_path` function body (column-0 close brace is the only one). */
function prefetchPathSource(): string {
  const src = readFileSync(SCRIPT, "utf8");
  const m = src.match(/^prefetch_path\(\) \{$[\s\S]*?^\}$/m);
  if (!m) throw new Error("prefetch_path not found in secret-materialize.sh");
  return m[0];
}

/** Run the real prefetch_path with a mocked bao_exec that returns (out, rc). */
function runPrefetch(mockOut: string, mockRc: number): number {
  const cache = mkdtempSync(path.join(tmpdir(), "prefetch-"));
  const harness = `
sleep() { :; }                                   # never wait the real 5s/10s backoff
bao_exec() { printf '%s' "$MOCK_OUT"; return "$MOCK_RC"; }
CACHE_DIR=${JSON.stringify(cache)}
DEPLOY_ENVIRONMENT=candidate-a
${prefetchPathSource()}
prefetch_path svc production spawny-boi
`;
  const r = spawnSync("bash", ["-c", harness], {
    env: { ...process.env, MOCK_OUT: mockOut, MOCK_RC: String(mockRc) },
    encoding: "utf8",
  });
  return r.status ?? -1;
}

describe("secret-materialize prefetch_path absent/transport/denied classification", () => {
  it("ABSENT (bao exit 2, no 403) → empty bucket, succeeds (bug.5206)", () => {
    // What a never-in-prod path surfaces via kubectl exec under -format=json.
    expect(runPrefetch("command terminated with exit code 2", 2)).toBe(0);
  });

  it("ABSENT (explicit 'No value found' text) → empty bucket, succeeds", () => {
    expect(runPrefetch("No value found at cogni/production/spawny-boi", 2)).toBe(
      0
    );
  });

  it("TRANSPORT (non-2 non-zero) → retried then fatal, never a false-empty (bug.5159)", () => {
    expect(
      runPrefetch("kex_exchange_identification: Connection reset by peer", 255)
    ).toBe(1);
  });

  it("DENIED (bao exit 2 WITH 403) → fatal, never empty — the 403 guard is load-bearing", () => {
    // bao exits 2 for permission-denied too; without the guard this would false-empty.
    expect(
      runPrefetch("Error reading cogni/production/spawny-boi: Code: 403", 2)
    ).toBe(1);
  });
});
