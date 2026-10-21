#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `scripts/vm-health-snapshot`
 * Purpose: One read-only command that snapshots every shared env VM (candidate-a, preview, production)
 *   from Grafana Cloud Prometheus and grades it GREEN / YELLOW / RED with named causes and the next action,
 *   so an agent never has to read a dashboard or SSH to answer "is the VM healthy, and what is eating it?".
 * Scope: Grafana datasource-proxy reads only (no SSH, no writes). Thresholds live in THRESHOLDS below and are
 *   documented in the `vm-health` skill; `evaluate()` is pure and unit-tested.
 * Invariants:
 *   - MISSING_IS_NOT_HEALTHY: absent or stale host telemetry grades RED, never GREEN.
 *   - VERDICT_FIRST: the first output line per env is the verdict; detail follows.
 * Side-effects: IO (HTTPS reads to GRAFANA_URL)
 * Links: story.5084, .claude/skills/vm-health/SKILL.md, hub prod-vm-swap-thrash, infra/grafana/dashboards/operator/fleet-status.json
 * @public
 *
 * Usage:
 *   node scripts/vm-health-snapshot.mjs                 # all envs, human summary
 *   node scripts/vm-health-snapshot.mjs production      # one env
 *   node scripts/vm-health-snapshot.mjs --json          # machine-readable
 * Credentials: GRAFANA_URL + GRAFANA_SERVICE_ACCOUNT_TOKEN from env, else ./.env.cogni (same as scripts/loki-query.sh).
 * Exit code: 0 all GREEN, 1 any YELLOW, 2 any RED, 3 usage/credential error.
 */

import { existsSync, readFileSync } from "node:fs";

export const ENVS = ["production", "preview", "candidate-a"];
const DB_SERVICES = "doltgres|temporal|temporal-postgres|postgres";

// [yellowAt, redAt]; direction "high" = bigger is worse, "low" = smaller is worse.
export const THRESHOLDS = {
  swapInPagesPerSec: {
    yellow: 10,
    red: 100,
    dir: "high",
    why: "kernel is paging memory back from disk",
  },
  dbMajorFaultsPerSec: {
    yellow: 5,
    red: 50,
    dir: "high",
    why: "databases are reading their own memory back from swap (slow queries, timeouts)",
  },
  ioWaitPct: {
    yellow: 5,
    red: 20,
    dir: "high",
    why: "CPUs are stalled waiting on disk",
  },
  memAvailablePct: {
    yellow: 25,
    red: 10,
    dir: "low",
    why: "little free RAM left before swapping",
  },
  diskUsedPct: {
    yellow: 80,
    red: 90,
    dir: "high",
    why: "root disk filling (backups, images, logs)",
  },
  probeFailures30m: {
    yellow: 1,
    red: 6,
    dir: "high",
    why: "public endpoints on this env failed health probes",
  },
  unattributedPct: {
    yellow: 30,
    red: 101,
    dir: "high",
    why: "a large share of used memory has no named owner (collector gap)",
  },
};

const queries = (env) => ({
  memTotalBytes: `max(node_memory_MemTotal_bytes{env="${env}"})`,
  memAvailablePct: `100 * min(node_memory_MemAvailable_bytes{env="${env}"} / node_memory_MemTotal_bytes{env="${env}"})`,
  swapUsedBytes: `max(node_memory_SwapTotal_bytes{env="${env}"} - node_memory_SwapFree_bytes{env="${env}"})`,
  swapInPagesPerSec: `sum(rate(node_vmstat_pswpin{env="${env}"}[5m]))`,
  ioWaitPct: `100 * avg(rate(node_cpu_seconds_total{env="${env}",mode="iowait"}[5m]))`,
  diskUsedPct: `100 * max(1 - node_filesystem_avail_bytes{env="${env}",mountpoint="/"} / node_filesystem_size_bytes{env="${env}",mountpoint="/"})`,
  dbMajorFaultsPerSec: `sum(rate(container_memory_failures_total{env="${env}",failure_type="pgmajfault",service=~"${DB_SERVICES}"}[5m]))`,
  attributedBytes: `sum(container_memory_rss{env="${env}",class=~"compose|systemd|k8s"})`,
  usedBytes: `max(node_memory_MemTotal_bytes{env="${env}"} - node_memory_MemAvailable_bytes{env="${env}"})`,
  probeFailures30m: `sum(count_over_time((probe_success{environment="${env}",proof_class="serve"} == 0)[30m:1m])) or vector(0)`,
  telemetryAgeSec: `time() - max(timestamp(node_memory_MemAvailable_bytes{env="${env}"}))`,
});
const topQuery = (env) =>
  `topk(6, sum by (class, service) ({__name__=~"container_memory_rss|container_memory_swap",env="${env}",class=~"compose|systemd|k8s"}))`;
const dbFaultsByService = (env) =>
  `sum by (service) (rate(container_memory_failures_total{env="${env}",failure_type="pgmajfault",service=~"${DB_SERVICES}"}[5m]))`;
const failingProbes = (env) =>
  `min by (node_slug) (min_over_time(probe_success{environment="${env}",proof_class="serve"}[5m])) == 0`;

const RANK = { GREEN: 0, YELLOW: 1, RED: 2 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);

function grade(key, value) {
  const t = THRESHOLDS[key];
  if (value === null || value === undefined || Number.isNaN(value))
    return "GREEN";
  if (t.dir === "high")
    return value >= t.red ? "RED" : value >= t.yellow ? "YELLOW" : "GREEN";
  return value <= t.red ? "RED" : value <= t.yellow ? "YELLOW" : "GREEN";
}

/** Pure: metrics snapshot → { verdict, findings[], next }. */
export function evaluate(m) {
  const findings = [];
  if (m.telemetryAgeSec === null || m.telemetryAgeSec > 300) {
    return {
      verdict: "RED",
      findings: [
        {
          key: "telemetry",
          level: "RED",
          text: "no fresh host metrics (>5m) — missing telemetry is not health; check Alloy on this VM",
        },
      ],
      next: "Restore Alloy telemetry before trusting anything else.",
    };
  }
  const derived = { ...m };
  derived.unattributedPct =
    m.usedBytes && m.attributedBytes !== null
      ? Math.max(0, 100 * (1 - m.attributedBytes / m.usedBytes))
      : null;
  let verdict = "GREEN";
  for (const key of Object.keys(THRESHOLDS)) {
    const level = grade(key, derived[key]);
    if (level !== "GREEN") {
      findings.push({
        key,
        level,
        value: derived[key],
        text: THRESHOLDS[key].why,
      });
      verdict = worst(verdict, level);
    }
  }
  const keys = new Set(findings.map((f) => f.key));
  let next = "Nothing to do.";
  if (
    keys.has("probeFailures30m") &&
    !keys.has("swapInPagesPerSec") &&
    !keys.has("dbMajorFaultsPerSec")
  )
    next =
      "Endpoints failing without host pressure: check the failing nodes' lease/app (Loki readyz errors), not the VM.";
  if (
    keys.has("dbMajorFaultsPerSec") ||
    keys.has("swapInPagesPerSec") ||
    keys.has("memAvailablePct")
  )
    next =
      "Memory pressure: name the top consumers below; cut or budget them, or move the VM up a size (hub substrate-vm-migration).";
  if (
    keys.has("diskUsedPct") &&
    verdict !== "GREEN" &&
    next === "Nothing to do."
  )
    next =
      "Disk: inspect db_backups volume, docker/k3s images and journals; prune or grow disk.";
  if (keys.has("unattributedPct") && next === "Nothing to do.")
    next =
      "Collector gap: Alloy is not naming most memory — check the kubelet_cadvisor scrape and class relabels.";
  return { verdict, findings, next };
}

function loadCreds() {
  let url = process.env.GRAFANA_URL;
  let token = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  for (const f of [process.env.COGNI_ENV_FILE, ".env.cogni", ".env.local"]) {
    if ((url && token) || !f || !existsSync(f)) continue;
    for (const line of readFileSync(f, "utf8").split("\n")) {
      const mm = line.match(
        /^(GRAFANA_URL|GRAFANA_SERVICE_ACCOUNT_TOKEN)=(.*)$/
      );
      if (!mm) continue;
      const v = mm[2].trim().replace(/^['"]|['"]$/g, "");
      if (mm[1] === "GRAFANA_URL" && !url) url = v;
      if (mm[1] === "GRAFANA_SERVICE_ACCOUNT_TOKEN" && !token) token = v;
    }
  }
  if (!url || !token) {
    console.error(
      "GRAFANA_URL and GRAFANA_SERVICE_ACCOUNT_TOKEN required (env or .env.cogni)"
    );
    process.exit(3);
  }
  return { base: url.replace(/\/$/, ""), token };
}

async function prom(creds, expr) {
  const u = `${creds.base}/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query?query=${encodeURIComponent(expr)}`;
  const res = await fetch(u, {
    headers: { Authorization: `Bearer ${creds.token}` },
  });
  if (!res.ok)
    throw new Error(`prometheus ${res.status} for ${expr.slice(0, 80)}`);
  const body = await res.json();
  return body.data?.result ?? [];
}
const scalar = (r) => (r.length ? Number(r[0].value[1]) : null);

async function snapshot(creds, env) {
  const q = queries(env);
  const keys = Object.keys(q);
  const vals = await Promise.all(
    keys.map((k) => prom(creds, q[k]).then(scalar))
  );
  const m = Object.fromEntries(keys.map((k, i) => [k, vals[i]]));
  const [top, faults, failing] = await Promise.all([
    prom(creds, topQuery(env)),
    prom(creds, dbFaultsByService(env)),
    prom(creds, failingProbes(env)),
  ]);
  return {
    env,
    metrics: m,
    topConsumers: top
      .map((r) => ({
        service: `${r.metric.class}/${r.metric.service}`,
        mib: Math.round(Number(r.value[1]) / 1048576),
      }))
      .sort((a, b) => b.mib - a.mib),
    dbFaultsPerSec: Object.fromEntries(
      faults.map((r) => [
        r.metric.service,
        Number(Number(r.value[1]).toFixed(2)),
      ])
    ),
    failingNodesNow: failing.map((r) => r.metric.node_slug),
    ...evaluate(m),
  };
}

const fmt = (v, d = 1) =>
  v === null || v === undefined ? "n/a" : Number(v).toFixed(d);
const gib = (b) => (b === null ? "n/a" : `${(b / 1073741824).toFixed(1)}GiB`);

function render(s) {
  const m = s.metrics;
  const icon = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴" }[s.verdict];
  const lines = [
    `${icon} ${s.env.toUpperCase()} ${s.verdict} — ${s.next}`,
    `   RAM ${gib(m.memTotalBytes)} · free ${fmt(m.memAvailablePct, 0)}% · swap used ${gib(m.swapUsedBytes)} · swap-in ${fmt(m.swapInPagesPerSec)}/s · iowait ${fmt(m.ioWaitPct)}% · disk ${fmt(m.diskUsedPct, 0)}% · DB faults ${fmt(m.dbMajorFaultsPerSec)}/s · probe fails 30m ${fmt(m.probeFailures30m, 0)}`,
  ];
  for (const f of s.findings)
    lines.push(
      `   ${f.level === "RED" ? "🔴" : "🟡"} ${f.key}=${fmt(f.value)} — ${f.text}`
    );
  if (s.failingNodesNow.length)
    lines.push(`   failing now: ${s.failingNodesNow.join(", ")}`);
  if (s.topConsumers.length)
    lines.push(
      `   top: ${s.topConsumers.map((t) => `${t.service} ${t.mib}MiB`).join(" · ")}`
    );
  if (Object.keys(s.dbFaultsPerSec).length)
    lines.push(`   DB faults/s: ${JSON.stringify(s.dbFaultsPerSec)}`);
  return lines.join("\n");
}

async function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const envs = args.filter((a) => !a.startsWith("--"));
  const targets = envs.length ? envs : ENVS;
  const creds = loadCreds();
  const snaps = await Promise.all(targets.map((e) => snapshot(creds, e)));
  if (json)
    console.log(
      JSON.stringify(
        { at: new Date().toISOString(), snapshots: snaps },
        null,
        2
      )
    );
  else
    console.log(
      `VM health snapshot ${new Date().toISOString()}\n` +
        snaps.map(render).join("\n")
    );
  process.exit(Math.max(...snaps.map((s) => RANK[s.verdict])));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(String(e));
    process.exit(3);
  });
}
