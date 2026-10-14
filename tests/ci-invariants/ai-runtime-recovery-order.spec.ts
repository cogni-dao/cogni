// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/ai-runtime-recovery-order`
 * Purpose: Pin bug.5462's acyclic AI recovery graph.
 * Scope: Static workflow/script reads. Does NOT dispatch workflows, use SSH, or run Docker.
 * Invariants:
 *   - RECOVERY_PRECEDES_PROJECTION: infra reconciles recover installed runtime
 *     before node-substrate may call LiteLLM.
 *   - APP_PROMOTE_IS_NOT_INFRA_RECOVERY: app-only promotions skip shared recovery.
 *   - CANDIDATE_EXERCISES_REAL_SEAM: candidate infra uses the same recovery mode.
 * Side-effects: IO (reads two workflow files)
 * Links: bug.5462, scripts/ci/deploy-infra.sh, scripts/ci/secret-materialize.sh
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const promote = readFileSync(
  path.join(ROOT, ".github/workflows/promote-and-deploy.yml"),
  "utf8"
);
const candidate = readFileSync(
  path.join(ROOT, ".github/workflows/candidate-flight-infra.yml"),
  "utf8"
);

const job = (body: string, name: string): string | undefined =>
  body.match(
    new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z][a-z0-9-]+:\\n)`, "m")
  )?.[0];

describe("AI runtime recovery ordering (bug.5462)", () => {
  it("runs one lane-scoped recovery before node substrate on infra reconciles", () => {
    const recover = job(promote, "recover-infra-runtime");
    const substrate = job(promote, "node-substrate");
    expect(recover).toBeDefined();
    expect(substrate).toBeDefined();
    expect(recover).toContain("inputs.skip_infra != 'true'");
    expect(recover).toContain(
      "environment: ${{ needs.decide.outputs.environment }}"
    );
    expect(recover).toContain(
      "scripts/ci/deploy-infra.sh --recover-installed-runtime"
    );
    expect(substrate).toContain(
      "needs: [decide, reconcile-appset, reconcile-dns, recover-infra-runtime]"
    );
    expect(substrate).toContain(
      "needs.recover-infra-runtime.result == 'success' || needs.recover-infra-runtime.result == 'skipped'"
    );
    expect(promote.indexOf("  recover-infra-runtime:")).toBeLessThan(
      promote.indexOf("  node-substrate:")
    );
  });

  it("exercises the identical recovery mode before candidate full deploy", () => {
    const recoveryIndex = candidate.indexOf(
      "bash scripts/ci/deploy-infra.sh --recover-installed-runtime"
    );
    const deployIndex = candidate.indexOf(
      'bash scripts/ci/deploy-infra.sh --ref "$COGNI_REPO_REF"'
    );
    expect(recoveryIndex).toBeGreaterThan(0);
    expect(deployIndex).toBeGreaterThan(recoveryIndex);
  });
});
