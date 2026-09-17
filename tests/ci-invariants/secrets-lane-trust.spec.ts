// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/secrets-lane-trust`
 * Purpose: Pins the down-trust lane-custody grant (bug.5196) across the THREE places that
 *   must agree: the TS trust table the route fast-fails on, and the two shell copies of the
 *   `<env>-node-secrets-writer` OpenBao policy that actually enforce it.
 * Scope: Static reads of the repo. Does NOT contact OpenBao, a cluster, or a vault.
 * Invariants:
 *   - POLICY_IS_THE_GATE: the route check is a fast-fail; the OpenBao policy enforces.
 *     Both must state the same lane set or the API and the vault disagree.
 *   - COPIES_STAY_IN_SYNC: provision-env-vm.sh (cold start) and reconcile-env-substrate.sh
 *     (heal) each carry the policy and both say "KEEP IN SYNC". Until they are merged, the
 *     comment is enforced HERE — a comment cannot fail a build.
 *   - NO_UP_TRUST: no pre-prod environment may gain a `production` lane.
 *   - DENIES_FOLLOW_EVERY_LANE: `_system` and `_shared` are denied on every lane gained,
 *     data AND metadata — a per-node grant must never reach a shared path in ANY lane.
 * Side-effects: IO (reads repo scripts + source)
 * Links: bug.5196, docs/spec/secrets-management.md Invariant 1,
 *   nodes/operator/app/src/shared/secrets/secrets-lane-trust.data.ts
 * @public
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SECRETS_LANE_TRUST } from "../../nodes/operator/app/src/shared/secrets/secrets-lane-trust.data";

const ROOT = path.resolve(__dirname, "../..");
const SCRIPTS = [
  "scripts/setup/provision-env-vm.sh",
  "scripts/setup/reconcile-env-substrate.sh",
] as const;

/** The `case` block each script uses to pick the lane set. */
const LANE_CASE =
  /case "\$\{DEPLOY_ENV\}" in\s*\n\s*production\)\s*NODE_SECRET_LANES="([^"]+)"\s*;;\s*\n\s*\*\)\s*NODE_SECRET_LANES="\$\{DEPLOY_ENV\}"\s*;;/;

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("secrets lane trust (bug.5196)", () => {
  it("states the same production lane set in BOTH shell copies", () => {
    const sets = SCRIPTS.map((s) => {
      const m = read(s).match(LANE_CASE);
      expect(
        m,
        `${s} must select node-secrets-writer lanes by DEPLOY_ENV`
      ).not.toBeNull();
      return (m as RegExpMatchArray)[1].trim().split(/\s+/).sort();
    });
    expect(sets[0]).toEqual(sets[1]);
  });

  it("matches the TS table the route fast-fails on", () => {
    const fromTs = [...SECRETS_LANE_TRUST.production].sort();
    const m = read(SCRIPTS[0]).match(LANE_CASE) as RegExpMatchArray;
    expect(m[1].trim().split(/\s+/).sort()).toEqual(fromTs);
  });

  it("grants no pre-prod environment a production lane", () => {
    for (const [served, lanes] of Object.entries(SECRETS_LANE_TRUST)) {
      if (served === "production") continue;
      expect(lanes, `${served} must not custody production`).not.toContain(
        "production"
      );
    }
    // The shell mirrors it: every non-production env falls to its own env, nothing wider.
    for (const s of SCRIPTS) {
      expect(read(s)).toContain(
        '*)          NODE_SECRET_LANES="${DEPLOY_ENV}" ;;'
      );
    }
  });

  it("carries the _system and _shared denies onto every lane, data AND metadata", () => {
    for (const s of SCRIPTS) {
      const body = read(s);
      for (const shared of ["_system", "_shared"]) {
        for (const kind of ["data", "metadata"]) {
          expect(
            body,
            `${s} must deny ${kind}/<lane>/${shared} for the lane it templates`
          ).toContain(`path \\"cogni/${kind}/\${_lane}/${shared}/*\\"`);
        }
      }
    }
  });

  it("feeds the node-secrets-writer policy from the templated lane set, not a hardcoded env", () => {
    // Scoped to THIS policy on purpose. `<env>-writer` and `<env>-db-reader` are
    // different roles that correctly stay single-env — asserting repo-wide would
    // flag them and teach the next reader the wrong rule.
    for (const s of SCRIPTS) {
      const body = read(s);
      expect(body).toContain("for _lane in ${NODE_SECRET_LANES}; do");
      const idx = body.indexOf("${DEPLOY_ENV}-node-secrets-writer");
      expect(
        idx,
        `${s} must still write the node-secrets-writer policy`
      ).toBeGreaterThan(-1);
      const block = body.slice(idx, idx + 600);
      expect(
        block,
        `${s} node-secrets-writer must render from NODE_SECRETS_WRITER_HCL`
      ).toContain("${NODE_SECRETS_WRITER_HCL}");
      // The pre-bug.5196 shape wrote DEPLOY_ENV straight into THIS policy's paths.
      expect(block).not.toContain('path "cogni/data/${DEPLOY_ENV}/*"');
    }
  });
});
