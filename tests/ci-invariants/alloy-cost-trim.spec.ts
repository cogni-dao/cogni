// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/alloy-cost-trim`
 * Purpose: Pins the Grafana Cloud cost trim in the deployed Alloy config: 60s app/worker/openfga scrapes, PromQL windows that still span two scrapes, and argocd info logs dropped before Loki.
 * Scope: Reads committed Alloy and Grafana-as-code files; the log proof runs the deployed Alloy binary over owned temporary pod-log files. Does not access Grafana Cloud.
 * Invariants:
 *   - APP_SCRAPES_AT_60S: app_metrics, worker_metrics and openfga_metrics scrape every 60s
 *     (1 sample/min = 1 billable DPM per series instead of 4).
 *   - INFRA_SCRAPES_STAY_30S: cadvisor, node, postgres and kubelet_cadvisor keep 30s, so
 *     reliability evidence keeps 2 samples per 120s evidenceTtlMs.
 *   - WINDOW_SPANS_TWO_SCRAPES: every PromQL/LogQL range window in infra/grafana is ≥ 2× the
 *     longest Alloy scrape interval, so rate()/increase() never sees a single sample.
 *   - ARGOCD_INFO_DROPPED: argocd-namespace logfmt lines at level=info never reach Loki; warn,
 *     error, non-logfmt argocd lines and other namespaces' info lines still ship.
 *   - SKIP_IS_LOUD: without docker the native proof reports SKIPPED, never a silent pass.
 * Side-effects: IO (reads configs; owned temporary files and containers)
 * Links: task.5343, bug.5527, infra/compose/runtime/configs/alloy-config.metrics.alloy
 * @public
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
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
const METRICS_CONFIG = path.join(
  REPO_ROOT,
  "infra/compose/runtime/configs/alloy-config.metrics.alloy"
);
const COMPOSE = path.join(
  REPO_ROOT,
  "infra/compose/runtime/docker-compose.yml"
);
const GRAFANA_AS_CODE = ["alerts", "dashboards", "synthetic"].map((dir) =>
  path.join(REPO_ROOT, "infra/grafana", dir)
);

const metrics = readFileSync(METRICS_CONFIG, "utf8");

/** The committed top-level River block `<type> "<name>" { ... }`. */
function block(text: string, type: string, name: string): string {
  const found = text.match(
    new RegExp(
      `^${type.replaceAll(".", "\\.")} "${name}" \\{\\n[\\s\\S]*?^\\}`,
      "m"
    )
  );
  if (!found) throw new Error(`Missing declared ${type}.${name}`);
  return found[0];
}

const UNIT_SECONDS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
  w: 604_800,
};

/** Prometheus duration ("1m30s", "5m", "26h") → seconds. */
function durationSeconds(duration: string): number {
  let total = 0;
  for (const [, value, unit] of duration.matchAll(/(\d+)([smhdw])/g)) {
    total += Number(value) * (UNIT_SECONDS[unit as string] ?? Number.NaN);
  }
  return total;
}

function scrapeInterval(name: string): string {
  const found = block(metrics, "prometheus.scrape", name).match(
    /scrape_interval\s*=\s*"([^"]+)"/
  );
  if (!found?.[1]) throw new Error(`prometheus.scrape.${name} has no interval`);
  return found[1];
}

function filesUnder(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory())
      return entry.name.startsWith(".") ? [] : filesUnder(full);
    return /\.(ya?ml|json|tf)$/.test(entry.name) ? [full] : [];
  });
}

describe("Alloy cost trim (task.5343)", () => {
  it("APP_SCRAPES_AT_60S: app, worker and openfga scrape once per minute", () => {
    for (const name of ["app_metrics", "worker_metrics", "openfga_metrics"]) {
      expect(scrapeInterval(name), name).toBe("60s");
    }
  });

  it("INFRA_SCRAPES_STAY_30S: reliability evidence scrapes are untouched", () => {
    for (const name of ["cadvisor", "node", "postgres", "kubelet_cadvisor"]) {
      expect(scrapeInterval(name), name).toBe("30s");
    }
  });

  it("WINDOW_SPANS_TWO_SCRAPES: no Grafana-as-code range window is shorter than two scrapes", () => {
    const intervals = [
      ...metrics.matchAll(/scrape_interval\s*=\s*"([^"]+)"/g),
    ].map(([, interval]) => durationSeconds(interval as string));
    expect(intervals.length).toBeGreaterThan(0);
    const floor = 2 * Math.max(...intervals);
    const windows = GRAFANA_AS_CODE.flatMap(filesUnder).flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /\[((?:\d+[smhdw])+)(?::[^\]]*)?\]/g
        ),
      ].map(([match, duration]) => ({
        at: `${path.relative(REPO_ROOT, file)} ${match}`,
        seconds: durationSeconds(duration as string),
      }))
    );
    expect(windows.length).toBeGreaterThan(0);
    expect(windows.filter((window) => window.seconds < floor)).toEqual([]);
  });

  it("ARGOCD_INFO_DROPPED: the deployed pod-log pipeline drops argocd info lines only", async () => {
    let dockerUp = false;
    try {
      execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
      dockerUp = true;
    } catch {
      dockerUp = false;
    }
    if (!dockerUp) {
      // SKIP_IS_LOUD — explicit, never a silent pass.
      console.warn(
        "::warning::alloy-cost-trim: docker unavailable — SKIPPED the argocd info-drop proof. This gate did NOT run."
      );
      return;
    }
    const image = readFileSync(COMPOSE, "utf8").match(
      /grafana\/alloy:[A-Za-z0-9._-]+/
    )?.[0];
    if (!image) throw new Error("could not read the alloy image from compose");

    const marker = `alloy-argocd-${randomUUID()}`;
    const directory = mkdtempSync(path.join(tmpdir(), "alloy-argocd-"));
    const pods = path.join(directory, "pods");
    const cri = (stream: "stdout" | "stderr", message: string) =>
      `${new Date().toISOString()} ${stream} F ${message}`;
    const logfmt = (level: string, msg: string) =>
      `time="${new Date().toISOString()}" level=${level} msg="${marker} ${msg}" application=argocd/proof`;

    const argocdDropped = [
      logfmt("info", "Reconciliation completed"),
      // `level=warn` inside a quoted value must not rescue an info line.
      `time="${new Date().toISOString()}" level=info msg="${marker} level=warn in msg"`,
    ] as const;
    const argocdKept = [
      logfmt("warning", "Failed to compare desired state"),
      logfmt("error", "ComparisonError"),
      `${marker} plain non-logfmt argocd line`,
      logfmt("warning", "argocd sentinel"),
    ] as const;
    const otherKept = [
      logfmt("info", "kube-system info line"),
      logfmt("info", "kube-system sentinel"),
    ] as const;
    const writePod = (
      namespace: string,
      pod: string,
      container: string,
      lines: readonly string[]
    ) => {
      const dir = path.join(
        pods,
        `${namespace}_${pod}_${randomUUID()}`,
        container
      );
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "0.log"),
        `${lines.map((line) => cri("stderr", line)).join("\n")}\n`
      );
    };
    writePod(
      "argocd",
      "argocd-application-controller-0",
      "argocd-application-controller",
      [
        argocdDropped[0],
        argocdKept[0],
        argocdDropped[1],
        ...argocdKept.slice(1),
      ]
    );
    writePod("kube-system", "coredns-abcde", "coredns", otherKept);

    const proof = [
      'logging {\n  level = "info"\n  format = "json"\n}',
      block(metrics, "local.file_match", "k8s_pods"),
      block(metrics, "loki.source.file", "k8s_pods"),
      block(metrics, "loki.process", "k8s_pod_logs").replace(
        "loki.write.loki.receiver",
        "loki.echo.proof.receiver"
      ),
      'loki.echo "proof" {}',
    ].join("\n");
    writeFileSync(path.join(directory, "proof.alloy"), proof);

    let collector = "";
    try {
      collector = execFileSync(
        "docker",
        [
          "run",
          "-d",
          "--network",
          "none",
          "--user",
          "0:0",
          "--env",
          "DEPLOY_ENVIRONMENT=candidate-a",
          "--mount",
          `type=bind,source=${pods},target=/var/log/pods,readonly`,
          "--mount",
          `type=bind,source=${directory}/proof.alloy,target=/proof/proof.alloy,readonly`,
          image,
          "run",
          "/proof/proof.alloy",
          "--storage.path=/tmp/alloy-proof",
        ],
        { encoding: "utf8", timeout: 60_000 }
      ).trim();

      type Echo = { receiver: string; entry: string; labels: string };
      let entries: Echo[] = [];
      let lastLogs = "";
      try {
        await expect
          .poll(
            () => {
              const result = spawnSync("docker", ["logs", collector], {
                encoding: "utf8",
                timeout: 10_000,
                maxBuffer: 4 * 1024 * 1024,
              });
              lastLogs = result.stdout + result.stderr;
              entries = lastLogs.split("\n").flatMap((line) => {
                try {
                  const value = JSON.parse(line);
                  return value.receiver === "loki.echo.proof"
                    ? [value as Echo]
                    : [];
                } catch {
                  return [];
                }
              });
              return [argocdKept.at(-1), otherKept.at(-1)].every((sentinel) =>
                entries.some((row) => row.entry === sentinel)
              );
            },
            { timeout: 30_000, interval: 250 }
          )
          .toBe(true);
      } catch (cause) {
        throw new Error(
          `argocd info-drop proof did not complete: ${lastLogs.slice(-12000)}`,
          { cause }
        );
      }

      for (const line of argocdDropped)
        expect(
          entries.some((row) => row.entry === line),
          line
        ).toBe(false);
      for (const line of argocdKept) {
        const row = entries.find((candidate) => candidate.entry === line);
        expect(row, line).toBeDefined();
        expect(row?.labels).toContain('namespace="argocd"');
      }
      for (const line of otherKept) {
        const row = entries.find((candidate) => candidate.entry === line);
        expect(row, line).toBeDefined();
        expect(row?.labels).toContain('namespace="kube-system"');
      }
    } finally {
      if (collector) {
        try {
          execFileSync("docker", ["rm", "-f", collector], { stdio: "ignore" });
        } catch {
          /* Preserve the actual assertion failure. */
        }
      }
      rmSync(directory, { recursive: true, force: true });
    }
  }, 90_000);
});
