// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/alloy-config-parses`
 * Purpose: Parse committed Alloy configs and prove Docker payload preservation with the deployed binary.
 * Scope: Offline fmt plus owned Docker source/process/echo containers; does not access databases or external sinks.
 * Invariants:
 *   - ALLOY_CONFIG_PARSES: every `infra/compose/runtime/configs/*.alloy` parses.
 *   - VALIDATOR_MATCHES_DEPLOYED_BINARY: the image is read from docker-compose.yml, never
 *     hardcoded — a validator pinned to a different alloy than production runs is theatre.
 *   - SKIP_IS_LOUD: without docker the check reports SKIPPED explicitly; a skipped gate must
 *     never read as a pass.
 * Side-effects: IO (reads configs; owned temporary config/containers and read-only Docker socket)
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

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
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

  it("preserves native Docker JSON and probe filtering through both declared log pipelines", async () => {
    if (!available) {
      console.warn(
        "::warning::alloy-config-parses: docker unavailable — SKIPPED native Docker payload proof."
      );
      return;
    }
    const image = deployedAlloyImage();
    const marker = `alloy-payload-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "alloy-payload-"));
    const owned: string[] = [];
    const docker = (args: string[]) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 4 * 1024 * 1024,
      });
    const block = (text: string, type: string, name: string) => {
      const found = text.match(
        new RegExp(
          `^${type.replaceAll(".", "\\.")} "${name}" \\{\\n[\\s\\S]*?^\\}`,
          "m"
        )
      );
      if (!found) throw new Error(`Missing declared ${type}.${name}`);
      return found[0];
    };
    const metrics = readFileSync(
      path.join(CONFIG_DIR, "alloy-config.metrics.alloy"),
      "utf8"
    );
    const variants = [
      "metrics_repaired",
      "metrics_historical",
      "dev_repaired",
      "dev_historical",
    ];
    const discovery = block(metrics, "discovery.docker", "containers").replace(
      /\}$/,
      `  filter {\n    name = "label"\n    values = ["cogni.native.proof=${marker}"]\n  }\n}`
    );
    const source = block(metrics, "loki.source.docker", "default").replace(
      "[loki.process.docker_logs.receiver]",
      `[${variants.map((name) => `loki.process.${name}.receiver`).join(", ")}]`
    );
    const processes = variants.map((name) => {
      const file = name.startsWith("metrics")
        ? "alloy-config.metrics.alloy"
        : "alloy-config.alloy";
      let declared = block(
        readFileSync(path.join(CONFIG_DIR, file), "utf8"),
        "loki.process",
        "docker_logs"
      )
        .replace('"docker_logs"', `"${name}"`)
        .replace("loki.write.loki.receiver", `loki.echo.${name}.receiver`);
      if (name.endsWith("historical")) {
        // Actual retired decoder: its missing `log` field erases backup JSON.
        declared = declared.replace(
          /\{\n/,
          '{\n  stage.docker {}\n  stage.timestamp {\n    source = "time"\n    format = "RFC3339Nano"\n  }\n'
        );
      }
      return `${declared}\nloki.echo "${name}" {}`;
    });
    writeFileSync(
      path.join(directory, "proof.alloy"),
      [
        'logging {\n  level = "info"\n  format = "json"\n}',
        discovery,
        block(metrics, "discovery.relabel", "docker_logs"),
        source,
        ...processes,
      ].join("\n")
    );
    const backupTime = "2000-01-01T00:00:00Z";
    const backups = ["app", "temporal"].map((cluster) =>
      JSON.stringify({
        level: "info",
        event: "db_backup.completed",
        cluster,
        msg: `${marker}: backup completed`,
        path: `/backups/${cluster}/owned`,
        time: backupTime,
      })
    );
    const probe = (
      route: string,
      status: number,
      durationMs: number,
      msg: string
    ) =>
      JSON.stringify({
        route,
        status,
        durationMs,
        msg,
        time: backupTime,
        svcNode: marker,
      });
    const dropped = [
      probe("meta.readyz", 200, 1, "request received"),
      probe("meta.metrics", 200, 1, "request complete"),
      probe("meta.readyz", 200, 4, "request complete"),
    ];
    const kept = [
      probe("meta.readyz", 503, 4, "request complete"),
      probe("meta.readyz", 200, 1500, "request complete"),
      JSON.stringify({
        route: "meta.readyz",
        status: 200,
        msg: "request complete",
        time: backupTime,
      }),
      '{"route":',
    ];
    const plain = `${marker}: plain non-JSON`;
    const terminal = `${marker}: terminal`;
    const stderr = `${marker}: stderr`;
    const startedAt = Date.now();
    try {
      const collector = docker([
        "run",
        "-d",
        "--network",
        "none",
        "--user",
        "0:0",
        "--env",
        "DEPLOY_ENVIRONMENT=candidate-a",
        "--mount",
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock,readonly",
        "--mount",
        `type=bind,source=${directory},target=/proof,readonly`,
        image,
        "run",
        "/proof/proof.alloy",
        "--storage.path=/tmp/alloy-proof",
      ]).trim();
      owned.push(collector);
      const emitter = docker([
        "run",
        "-d",
        "--network",
        "none",
        "--label",
        `cogni.native.proof=${marker}`,
        "--label",
        "com.docker.compose.service=db-backup",
        "--env",
        `PROOF_STDERR=${stderr}`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        'printf "%s\\n" "$@"; printf "%s\\n" "$PROOF_STDERR" >&2; sleep 25',
        "owned-emitter",
        ...backups,
        ...dropped,
        ...kept,
        plain,
        terminal,
      ]);
      owned.push(emitter.trim());
      type Echo = {
        receiver: string;
        entry: string;
        entry_timestamp: string;
        labels: string;
      };
      let echoes: Echo[] = [];
      let lastLogs = "";
      await expect
        .poll(
          () => {
            const result = spawnSync("docker", ["logs", collector], {
              encoding: "utf8",
              timeout: 10_000,
              maxBuffer: 4 * 1024 * 1024,
            });
            if (result.status !== 0)
              throw new Error(
                `Native collector logs unavailable: ${result.stderr}`
              );
            const logs = result.stdout + result.stderr;
            lastLogs = logs;
            echoes = logs.split("\n").flatMap((line) => {
              try {
                const value = JSON.parse(line);
                return typeof value.receiver === "string" &&
                  value.receiver.startsWith("loki.echo.")
                  ? [value as Echo]
                  : [];
              } catch {
                return [];
              }
            });
            return variants.every((name) =>
              [terminal, stderr].every((entry) =>
                echoes.some(
                  (line) =>
                    line.receiver === `loki.echo.${name}` &&
                    line.entry === entry
                )
              )
            );
          },
          { timeout: 20_000, interval: 200 }
        )
        .toBe(true)
        .catch((cause: unknown) => {
          throw new Error(
            `Native Docker payload proof did not complete: ${lastLogs.slice(-12000)}`,
            { cause }
          );
        });
      for (const name of variants) {
        const rows = echoes.filter(
          (line) => line.receiver === `loki.echo.${name}`
        );
        expect(rows.some((line) => line.entry === plain)).toBe(true);
        expect(rows.find((line) => line.entry === stderr)?.labels).toContain(
          'stream="stderr"'
        );
        if (name.endsWith("historical")) {
          expect(rows.some((line) => line.entry === "")).toBe(true);
          expect(rows.some((line) => backups.includes(line.entry))).toBe(false);
        } else {
          for (const entry of [...backups, ...kept]) {
            const row = rows.find((line) => line.entry === entry);
            expect(row, `${name} lost ${entry}`).toBeDefined();
            expect(row?.labels).toContain('service="db-backup"');
            expect(row?.labels).toContain('stream="stdout"');
            expect(
              Date.parse(row?.entry_timestamp ?? "")
            ).toBeGreaterThanOrEqual(startedAt - 1000);
          }
          for (const entry of dropped)
            expect(rows.some((line) => line.entry === entry)).toBe(false);
          expect(rows.find((line) => line.entry === kept[0])?.labels).toContain(
            `node="${marker}"`
          );
        }
      }
    } finally {
      for (const id of owned.reverse()) {
        try {
          docker(["rm", "-f", id]);
        } catch {
          /* Preserve the actual assertion failure. */
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 75_000);
});
