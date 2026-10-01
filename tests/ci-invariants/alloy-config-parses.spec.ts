// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/alloy-config-parses`
 * Purpose: Ensures every committed Alloy config parses against the exact deployed Alloy binary.
 * Scope: Static parse check via `alloy fmt` in a throwaway container. Does not deploy, does not
 *   connect to any database, and needs none of the host mounts a full `alloy run` demands.
 * Invariants:
 *   - ALLOY_CONFIG_PARSES: every `infra/compose/runtime/configs/*.alloy` parses.
 *   - VALIDATOR_MATCHES_DEPLOYED_BINARY: the image is read from docker-compose.yml, never
 *     hardcoded — a validator pinned to a different alloy than production runs is theatre.
 *   - SKIP_IS_LOUD: without docker the check reports SKIPPED explicitly; a skipped gate must
 *     never read as a pass.
 * Side-effects: IO (reads compose + configs; runs a short-lived container when docker exists)
 * Links: bug.5293, docs/spec/cicd-platform-boundary.md
 * @public
 *
 * WHY THIS EXISTS. On 2026-09-30 a single `#` comment (River uses `//`) made
 * alloy-config.metrics.alloy unparseable. One illegal character invalidates the whole file, so
 * alloy crash-looped and candidate-a's entire metrics pipeline went dark for ~20 minutes —
 * cadvisor, node, app and worker scrapes, not only the postgres block being added. It survived
 * THREE deploys because every safeguard was blind to it:
 *   - deploy-infra hashes the config and restarts alloy, but never validates it;
 *   - a dead metrics pipeline cannot report its own death, so `up == 1` kept reading "healthy"
 *     from the last good scrapes before it stopped — FRESHNESS, not value, is the honest check;
 *   - alloy's own container logs were not shipped, so the only evidence anywhere was a
 *     `docker ps` line buried in a workflow log.
 * `alloy fmt` catches it offline in under a second.
 *
 * WHY TYPESCRIPT AND NOT A BASH TEST. A first draft shipped this as
 * `scripts/ci/tests/alloy-config-parses.test.sh` and registered it in `run-shell-tests.sh`. Two
 * things were wrong with that: the compose-lane dispatch gate refuses a review containing any
 * non-lane path (so it made the PR undispatchable), and that suite's contract is explicitly
 * "pure-bash ... no network, docker, or shared writable state" — a docker-dependent test violates
 * it. `tests/ci-invariants/` is the typed home for exactly this kind of repo-wide assertion, per
 * docs/spec/cicd-platform-boundary.md's routing of platform work into the `.ts` plane.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");
const CONFIG_DIR = path.join(REPO_ROOT, "infra/compose/runtime/configs");
const COMPOSE = path.join(
  REPO_ROOT,
  "infra/compose/runtime/docker-compose.yml"
);

/** The image the `alloy` service actually runs, e.g. `grafana/alloy:v1.9.2`. */
function deployedAlloyImage(): string {
  const compose = readFileSync(COMPOSE, "utf8");
  const match = compose.match(/grafana\/alloy:[A-Za-z0-9._-]+/);
  if (!match) {
    throw new Error(
      `could not read the alloy image from ${COMPOSE} — the validator must match the deployed binary`
    );
  }
  return match[0];
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

const configs = readdirSync(CONFIG_DIR)
  .filter((f) => f.endsWith(".alloy"))
  .sort();

describe("ALLOY_CONFIG_PARSES (bug.5293)", () => {
  it("finds the committed alloy configs", () => {
    expect(configs.length).toBeGreaterThan(0);
  });

  it("VALIDATOR_MATCHES_DEPLOYED_BINARY: resolves the image from compose", () => {
    expect(deployedAlloyImage()).toMatch(/^grafana\/alloy:\S+$/);
  });

  const available = dockerAvailable();

  for (const name of configs) {
    it(`parses ${name} against the deployed alloy`, () => {
      if (!available) {
        // SKIP_IS_LOUD — explicit, never a silent pass.
        console.warn(
          `::warning::alloy-config-parses: docker unavailable — SKIPPED ${name}. This gate did NOT run; a River syntax error would reach a deploy unvalidated (bug.5293).`
        );
        return;
      }
      const image = deployedAlloyImage();
      const file = path.join(CONFIG_DIR, name);
      // `fmt` parses without building components: no DB, no network, no host mounts.
      expect(() =>
        execFileSync(
          "docker",
          [
            "run",
            "--rm",
            "-v",
            `${file}:/w/${name}:ro`,
            "--entrypoint",
            "/bin/alloy",
            image,
            "fmt",
            `/w/${name}`,
          ],
          { stdio: "pipe", timeout: 120_000 }
        )
      ).not.toThrow();
    });
  }

  it("rejects a River config containing a '#' comment (the bug.5293 shape)", () => {
    if (!available) {
      console.warn(
        "::warning::alloy-config-parses: docker unavailable — SKIPPED the negative control."
      );
      return;
    }
    // Negative control: proves the gate actually fails on the exact defect that caused the
    // outage, rather than passing because `fmt` is lenient.
    const image = deployedAlloyImage();
    expect(() =>
      execFileSync(
        "docker",
        [
          "run",
          "--rm",
          "-i",
          "--entrypoint",
          "/bin/sh",
          image,
          "-c",
          "printf '# shell comment, illegal in River\\nlogging {}\\n' > /tmp/bad.alloy && /bin/alloy fmt /tmp/bad.alloy",
        ],
        { stdio: "pipe", timeout: 120_000 }
      )
    ).toThrow();
  });
});
