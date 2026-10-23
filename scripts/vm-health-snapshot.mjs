#!/usr/bin/env node
// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/vm-health-snapshot`
 * Purpose: Grades each shared env VM against the ONE reliability policy (recorded cogni_reliability_v1_* series) and names what is eating it; also prints the story.5084 soak objectives (24h per-endpoint availability, throttle-controller liveness, backup receipts) exactly as the private Fleet Reliability dashboard shows them.
 * Scope: Read-only Grafana datasource-proxy instant queries (Prometheus + Loki); does not SSH, write, or own any threshold.
 * Invariants: ONE_HEALTH_CONTRACT (grade only reliability-policy.v1.json signals and objectives) ; MISSING_IS_UNKNOWN (null/stale/multi-host never GREEN) ; ENDPOINTS_ARE_NOT_VM and OBJECTIVES_ARE_NOT_VM (neither changes the VM verdict or exit code), evaluate()/evaluateObjectives() pure
 * Side-effects: IO
 * Notes: Consumers, swap-in and major faults are ungraded diagnostic detail. Envs are validated before any PromQL is built; hosts must be 32-hex.
 * Links: packages/node-contracts/src/reliability-policy.v1.json, infra/grafana/synthetic/main.tf, infra/grafana/dashboards/operator/fleet-capacity.json, .claude/skills/vm-health/SKILL.md, story.5084
 * @public
 *
 * Usage:
 *   node scripts/vm-health-snapshot.mjs [production|preview|candidate-a ...] [--json]
 * Credentials: GRAFANA_URL (https) + GRAFANA_SERVICE_ACCOUNT_TOKEN from env, else ./.env.cogni.
 * Exit code (VM verdict only): 0 all GREEN · 1 worst YELLOW · 2 any RED or UNKNOWN · 3 usage/credential error · 4 Grafana unreachable for every env.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
/** The single threshold contract (ONE_HEALTH_CONTRACT). Imported, never copied. */
export const POLICY = require("../packages/node-contracts/src/reliability-policy.v1.json");

/** Mirrors reliabilityEnvironmentSchema in packages/node-contracts. */
export const ENVS = ["production", "preview", "candidate-a"];

/** Policy signal → recorded series (infra/grafana/synthetic/main.tf reliability_recording). */
export const SIGNAL_SERIES = {
  ioPressurePercent: "cogni_reliability_v1_io_pressure_percent",
  connectionsPercent: "cogni_reliability_v1_connections_percent",
  memoryHeadroomPercent: "cogni_reliability_v1_memory_headroom_percent",
  diskHeadroomPercent: "cogni_reliability_v1_disk_headroom_percent",
};

/** Telemetry families whose freshness is checked per host. `node` feeds the policy series. */
export const FAMILIES = {
  node: {
    required: true,
    metric: "node_memory_MemAvailable_bytes",
    job: "integrations/unix",
  },
  cadvisor: {
    required: false,
    metric: "container_memory_rss",
    job: "integrations/cadvisor",
  },
  kubelet_cadvisor: {
    required: false,
    metric: "container_memory_rss",
    job: "kubelet_cadvisor",
  },
};

const TTL_SEC = POLICY.evidenceTtlMs / 1000;
const HOST_RE = /^[0-9a-f]{32}$/;
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A proven RED outranks UNKNOWN so the first line never hides a known critical signal.
const RANK = { GREEN: 0, YELLOW: 1, UNKNOWN: 2, RED: 3 };
const worst = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const finite = (v) => typeof v === "number" && Number.isFinite(v);

const ACTIONS = {
  diskHeadroomPercent:
    "Disk: inspect the db_backups volume, docker/k3s images and journals; prune or grow the disk.",
  memoryHeadroomPercent:
    "Memory: cut or budget the top consumers below, or move the VM up a size (hub substrate-vm-migration).",
  ioPressurePercent:
    "I/O: check swap-in and major faults below (memory pressure is the usual cause), else a heavy DB/backup job.",
  connectionsPercent:
    "Connections: find the database/pool holding backends (operator /observability/health databaseShare5m).",
};

/** Policy grading, identical to the operator evaluator: above → value >= threshold; below → value <= threshold. */
export function gradeSignal(key, value) {
  const s = POLICY.signals[key];
  if (!s || !finite(value)) return "UNKNOWN";
  const hit = (t) => (s.direction === "above" ? value >= t : value <= t);
  if (hit(s.critical)) return "RED";
  if (hit(s.warning)) return "YELLOW";
  return "GREEN";
}

const isFresh = (tsSec, nowSec, ttlSec = TTL_SEC) =>
  finite(tsSec) && nowSec - tsSec <= ttlSec && tsSec - nowSec <= 15;

/**
 * Serve-probe evidence bounds for one env, owned by policy serveProbes (bug.5527):
 * the readiness window, and a freshness TTL that tolerates one missed probe run
 * (never tighter than the policy evidence TTL).
 */
export function serveProbeBounds(env) {
  const p = POLICY.serveProbes?.[env];
  if (
    !finite(p?.frequencyMs) ||
    !/^[1-9][0-9]*[smh]$/.test(p?.evidenceWindow ?? "")
  )
    throw new Error(`policy has no usable serveProbes for ${env}`);
  return {
    window: p.evidenceWindow,
    ttlSec: Math.max(TTL_SEC, (2 * p.frequencyMs) / 1000),
  };
}

/**
 * Pure: one env's evidence → verdict.
 * input = { nowSec, signals: {policyKey: [{host,value,tsSec}]}, families: {name: [{host,tsSec}]}, probes: {tsSec, nodes: [{slug,min}]} }
 */
export function evaluate(input) {
  const nowSec = input?.nowSec;
  const signals = input?.signals ?? {};
  const families = input?.families ?? {};
  const findings = [];
  const actions = [];

  const freshHosts = new Set();
  for (const key of Object.keys(POLICY.signals))
    for (const s of signals[key] ?? [])
      if (HOST_RE.test(s.host ?? "") && isFresh(s.tsSec, nowSec))
        freshHosts.add(s.host);
  const host = freshHosts.size === 1 ? [...freshHosts][0] : null;
  if (freshHosts.size === 0)
    findings.push({
      key: "policy-series",
      level: "UNKNOWN",
      text: `no fresh cogni_reliability_v1_* series (TTL ${TTL_SEC}s) — check Alloy on this VM and the reliability recording rules`,
    });
  if (freshHosts.size > 1)
    findings.push({
      key: "substrate-host",
      level: "UNKNOWN",
      text: `${freshHosts.size} substrate hosts report for one env (${[...freshHosts].map((h) => h.slice(0, 8)).join(", ")}) — ambiguous VM identity`,
    });

  let verdict = host ? "GREEN" : "UNKNOWN";
  const graded = [];
  for (const [key, s] of Object.entries(POLICY.signals)) {
    const samples = host
      ? (signals[key] ?? []).filter(
          (x) => x.host === host && finite(x.value) && isFresh(x.tsSec, nowSec)
        )
      : [];
    // Several node_slug recordings share one host; take the policy-worst value.
    const value = samples.length
      ? (s.direction === "above" ? Math.max : Math.min)(
          ...samples.map((x) => x.value)
        )
      : null;
    const level = SIGNAL_SERIES[key] ? gradeSignal(key, value) : "UNKNOWN";
    graded.push({
      key,
      value,
      level,
      warning: s.warning,
      critical: s.critical,
      direction: s.direction,
    });
    verdict = worst(verdict, level);
    if (level === "UNKNOWN" && host)
      findings.push({
        key,
        level,
        text: `${key} missing or stale for host ${host.slice(0, 8)}`,
      });
    if (level === "RED" || level === "YELLOW") {
      findings.push({
        key,
        level,
        value,
        text: `${key} ${level === "RED" ? "critical" : "warning"} per policy`,
      });
      actions.push({
        level,
        text: ACTIONS[key] ?? `${key}: see policy owner.`,
      });
    }
  }

  const familyAges = {};
  for (const [name, f] of Object.entries(FAMILIES)) {
    const ts = (families[name] ?? [])
      .filter((x) => x.host === host && finite(x.tsSec))
      .map((x) => x.tsSec);
    const age = ts.length ? nowSec - Math.max(...ts) : null;
    familyAges[name] = age;
    if (!host || (age !== null && age <= TTL_SEC)) continue;
    const level = f.required ? "UNKNOWN" : "YELLOW";
    findings.push({
      key: `family:${name}`,
      level,
      text: `${name} telemetry ${age === null ? "absent" : `stale ${Math.round(age)}s`}${f.required ? "" : " — consumers cannot be named"}`,
    });
    verdict = worst(verdict, level);
    if (!f.required)
      actions.push({
        level: "YELLOW",
        text: `Collector gap: ${name} absent — roll the current Alloy config (#2849) to this VM and check its scrape \`up\`.`,
      });
  }

  if (verdict === "UNKNOWN")
    actions.unshift({
      level: "UNKNOWN",
      text: "Restore evidence before trusting anything: Alloy on this VM, remote_write, and the reliability recording rules.",
    });
  actions.sort((a, b) => RANK[b.level] - RANK[a.level]);
  const next = actions.length ? actions.map((a) => a.text) : ["Nothing to do."];

  return {
    verdict,
    host,
    signals: graded,
    families: familyAges,
    findings,
    next,
    endpoints: evaluateEndpoints(input?.probes, nowSec),
  };
}

/** Pure: probe evidence → separate node-endpoint status (never part of the VM verdict). */
export function evaluateEndpoints(probes, nowSec) {
  // Evidence without env bounds is held to production's (strictest) policy bounds.
  const { window, ttlSec } = probes?.window
    ? probes
    : serveProbeBounds("production");
  if (!probes || !isFresh(probes.tsSec, nowSec, ttlSec))
    return {
      status: "UNKNOWN",
      failing: [],
      total: 0,
      text: "no fresh probe_success",
    };
  const nodes = (probes.nodes ?? []).filter((n) => SLUG_RE.test(n.slug ?? ""));
  const failing = [
    ...new Set(
      nodes.filter((n) => finite(n.min) && n.min < 1).map((n) => n.slug)
    ),
  ].sort();
  return {
    status: failing.length ? "FAILING" : "OK",
    failing,
    total: new Set(nodes.map((n) => n.slug)).size,
    text: failing.length
      ? `${failing.length}/${nodes.length} failing in ${window} (${failing.join(", ")}) — node app/lease, not the VM: read their readyz in Loki`
      : `${nodes.length} passing`,
  };
}

/** story.5084 soak objectives, owned by the policy (never VM signals). */
export const OBJECTIVES = POLICY.objectives;

/** Loki selectors for the objectives; identical to fleet-capacity.json panels. */
export const OBJECTIVE_LOGS = {
  // The actuator pod's container is `actuator`, so that is its Loki `service`.
  throttleController:
    'service="actuator",pod=~"operator-database-reliability-actuator-.*"',
  sweepEvent: "feature.node_reliability.sweep_complete",
  backup: 'service="db-backup"',
  backupEvent: "db_backup.completed",
};

const pct = (v) => (finite(v) ? `${v.toFixed(3)}%` : "n/a");
const ago = (sec) =>
  finite(sec)
    ? sec >= 3600
      ? `${(sec / 3600).toFixed(1)}h ago`
      : `${Math.max(0, Math.round(sec / 60))}m ago`
    : "none in 7d";

/**
 * Pure: soak evidence → graded objectives (never part of the VM verdict).
 * input = { availability: {nodes: [{slug, ratio}], byProbe: [{slug, probe, ratio}]} | null,
 *   controller: {sweeps, lastSec, errorLines} | null, backups: {receipts, lastSec} | null }.
 * Availability is graded per endpoint (node_slug × probe); per-node averages are ungraded context.
 * An empty Loki count is a real zero (no receipt), so it grades RED, never GREEN; null = query failed = UNKNOWN.
 * Throws when the policy has no usable objectives; callers wrap it (guardObjectives).
 */
export function evaluateObjectives(input, nowSec, objectives = OBJECTIVES) {
  const av = objectives?.nodeAvailability;
  const tc = objectives?.throttleController;
  const br = objectives?.backupReceipts;
  if (
    !finite(av?.targetPercent) ||
    !finite(tc?.minSweeps) ||
    !finite(br?.minReceipts)
  )
    throw new Error("policy has no usable objectives");
  const since = (t) => (finite(t) ? nowSec - t : null);
  const byPercent = (x, y) =>
    x.percent - y.percent || x.name.localeCompare(y.name);

  const a = input?.availability;
  const endpoints = (a?.byProbe ?? [])
    .filter((p) => SLUG_RE.test(p.slug ?? "") && finite(p.ratio))
    .map((p) => {
      const percent = p.ratio * 100;
      return {
        name: `${p.slug}·${p.probe || "unknown-probe"}`,
        slug: p.slug,
        probe: p.probe || "unknown-probe",
        percent,
        level: percent >= av.targetPercent ? "GREEN" : "RED",
      };
    })
    .sort(byPercent);
  const nodes = (a?.nodes ?? [])
    .filter((n) => SLUG_RE.test(n.slug ?? "") && finite(n.ratio))
    .map((n) => ({ name: n.slug, slug: n.slug, percent: n.ratio * 100 }))
    .sort(byPercent);
  const below = endpoints.filter((e) => e.level === "RED").map((e) => e.name);
  const availability = {
    level: !endpoints.length ? "UNKNOWN" : below.length ? "RED" : "GREEN",
    window: av.window,
    targetPercent: av.targetPercent,
    endpoints,
    below,
    nodes,
  };

  const c = input?.controller;
  const sweeps = c ? (finite(c.sweeps) ? c.sweeps : 0) : null;
  const controller = {
    level:
      sweeps === null ? "UNKNOWN" : sweeps >= tc.minSweeps ? "GREEN" : "RED",
    window: tc.window,
    minSweeps: tc.minSweeps,
    sweeps,
    lastSweepAgeSec: since(c?.lastSec),
    errorLines1h: c && finite(c.errorLines) ? c.errorLines : c ? 0 : null,
  };

  const b = input?.backups;
  const receipts = b ? (finite(b.receipts) ? b.receipts : 0) : null;
  const backups = {
    level:
      receipts === null
        ? "UNKNOWN"
        : receipts >= br.minReceipts
          ? "GREEN"
          : "RED",
    window: br.window,
    minReceipts: br.minReceipts,
    receipts,
    lastAgeSec: since(b?.lastSec),
  };

  return {
    level: [availability, controller, backups]
      .map((o) => o.level)
      .reduce(worst, "GREEN"),
    availability,
    controller,
    backups,
  };
}

/** OBJECTIVES_ARE_NOT_VM: any objectives failure becomes `{level: UNKNOWN, error}`; it can never reject a snapshot. */
export async function guardObjectives(run) {
  try {
    return await run();
  } catch (e) {
    return { level: "UNKNOWN", error: String(e?.message ?? e), errors: [] };
  }
}

/** Pure: graded objectives → the CLI lines (same numbers as the dashboard top row). */
export function renderObjectives(o) {
  if (!o?.availability || !o.controller || !o.backups)
    return [`   objectives: ⚪ UNKNOWN (${o?.error ?? "not evaluated"})`];
  const a = o.availability;
  const c = o.controller;
  const b = o.backups;
  const mark = (level) => (level === "GREEN" ? "" : `${ICON[level]} `);
  const n = a.endpoints.length;
  return [
    `   availability ${a.window} per endpoint (not VM; target ≥${a.targetPercent}%): ${a.level === "UNKNOWN" ? "⚪ UNKNOWN no probe_success" : `${a.below.length ? `🔴 ${a.below.length}/${n} endpoints below target` : `OK ${n}/${n} endpoints at target`} (${n} observed) — ${a.endpoints.map((e) => `${mark(e.level)}${e.name} ${pct(e.percent)}`).join(" · ")}`}`,
    `   node averages ${a.window} (context, ungraded): ${a.nodes.length ? a.nodes.map((x) => `${x.slug} ${pct(x.percent)}`).join(" · ") : "n/a"}`,
    `   throttle controller (not VM): ${c.level === "UNKNOWN" ? "⚪ UNKNOWN Loki query failed" : `${c.level === "GREEN" ? "OK alive" : "🔴 DEAD"} ${c.sweeps} sweeps in ${c.window} (min ${c.minSweeps}) · last sweep ${ago(c.lastSweepAgeSec)} · ${c.errorLines1h ?? "n/a"} "Error: " lines in 1h`}`,
    `   backups (not VM): ${b.level === "UNKNOWN" ? "⚪ UNKNOWN Loki query failed" : `${b.level === "GREEN" ? "OK" : "🔴"} ${b.receipts} receipts in ${b.window} (min ${b.minReceipts}) · last ${ago(b.lastAgeSec)}`}`,
  ];
}

/** Pure: per-service rss/swap rows → top consumers + memory outside per-service RSS (ungraded). */
export function summarizeConsumers(rssRows, swapRows, usedBytes, top = 8) {
  const byService = new Map();
  const add = (rows, field) => {
    for (const r of rows ?? []) {
      const id = `${r.class}/${r.service}`;
      const cur = byService.get(id) ?? { service: id, rss: 0, swap: 0 };
      cur[field] += finite(r.bytes) ? r.bytes : 0;
      byService.set(id, cur);
    }
  };
  add(rssRows, "rss");
  add(swapRows, "swap");
  const all = [...byService.values()].sort(
    (a, b) => b.rss + b.swap - (a.rss + a.swap)
  );
  const rssTotal = all.reduce((n, s) => n + s.rss, 0);
  const outside =
    finite(usedBytes) && (rssRows ?? []).length
      ? Math.max(0, usedBytes - rssTotal)
      : null;
  return { top: all.slice(0, top), rssTotal, outsideRssBytes: outside };
}

// ---------------------------------------------------------------- IO ----

class UsageError extends Error {}
class GrafanaError extends Error {}
class CredentialError extends Error {}

function loadCreds() {
  let url = process.env.GRAFANA_URL;
  let token = process.env.GRAFANA_SERVICE_ACCOUNT_TOKEN;
  for (const f of [process.env.COGNI_ENV_FILE, ".env.cogni"]) {
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
  if (!url || !token)
    throw new UsageError(
      "GRAFANA_URL and GRAFANA_SERVICE_ACCOUNT_TOKEN required (env or .env.cogni)"
    );
  let base;
  try {
    base = new URL(url);
  } catch {
    throw new UsageError("GRAFANA_URL is not a URL");
  }
  if (base.protocol !== "https:")
    throw new UsageError("GRAFANA_URL must be https");
  return { base: base.toString().replace(/\/$/, ""), token };
}

const DATASOURCES = {
  prometheus: {
    path: "grafanacloud-prom/api/v1/query",
    time: (sec) => String(sec),
  },
  // Loki reads an integer `time` as nanoseconds.
  loki: {
    path: "grafanacloud-logs/loki/api/v1/query",
    time: (sec) => `${sec}000000000`,
  },
};

async function query(creds, kind, expr, timeSec) {
  const ds = DATASOURCES[kind];
  const u = new URL(`${creds.base}/api/datasources/proxy/uid/${ds.path}`);
  u.searchParams.set("query", expr);
  u.searchParams.set("time", ds.time(timeSec));
  let res;
  try {
    res = await fetch(u, {
      headers: { Authorization: `Bearer ${creds.token}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new GrafanaError(`grafana unreachable: ${e?.name ?? "error"}`);
  }
  if (res.status === 401 || res.status === 403)
    throw new CredentialError(
      `grafana rejected credentials (HTTP ${res.status})`
    );
  if (!res.ok) throw new GrafanaError(`${kind} HTTP ${res.status}`);
  const body = await res.json().catch(() => null);
  if (body?.status !== "success" || body.data?.resultType !== "vector")
    throw new GrafanaError(
      `${kind} status ${body?.status ?? "malformed"}: ${body?.error ?? ""}`.trim()
    );
  return body.data.result;
}

const num = (r) => Number(r.value[1]);
const labelKey = (m) =>
  JSON.stringify(
    Object.entries(m)
      .filter(([k]) => k !== "__name__")
      .sort(([a], [b]) => a.localeCompare(b))
  );

/** Builds every selector from validated identifiers only. */
function selectors(env, host) {
  if (!ENVS.includes(env)) throw new UsageError(`unknown env ${env}`);
  if (host !== undefined && !HOST_RE.test(host))
    throw new Error("invalid substrate_host");
  return {
    policy: `environment="${env}",policy_version="${POLICY.version}"`,
    host: `env="${env}",substrate_host="${host}"`,
    family: (f) =>
      `${f.metric}{env="${env}",job="${f.job}",substrate_host!=""}`,
    probe: `probe_success{environment="${env}",proof_class="serve"}`,
    logs: (labels) => `{env="${env}",${labels}}`,
  };
}

const DURATION_RE = /^[1-9][0-9]*[smhd]$/;
const LAST_TS =
  " | label_format ts=`{{ __timestamp__ | unixEpoch }}` | unwrap ts [7d]";

/**
 * Queries the story.5084 objectives with the dashboard's own expressions. A failed group stays null (UNKNOWN);
 * an ungraded "last …" or error-count read failing never turns its graded count UNKNOWN.
 */
async function objectives(run, env, nowSec, policyObjectives) {
  const s = selectors(env);
  const av = policyObjectives?.nodeAvailability;
  const tc = policyObjectives?.throttleController;
  const br = policyObjectives?.backupReceipts;
  for (const w of [av?.window, tc?.window, br?.window])
    if (!DURATION_RE.test(w ?? ""))
      throw new Error(`invalid or missing policy objectives window ${w}`);
  const prom1 = (expr) => run("prometheus", expr);
  const loki1 = async (expr) => {
    const r = await run("loki", expr);
    return r.length ? num(r[0]) : null;
  };
  const detail = (expr) => loki1(expr).catch(() => null);
  const L = OBJECTIVE_LOGS;
  const sweep = `${s.logs(L.throttleController)} | json | event="${L.sweepEvent}"`;
  const backup = `${s.logs(L.backup)} | json | event="${L.backupEvent}"`;
  const availability = `avg_over_time(${s.probe}[${av.window}])`;
  const [a, c, b] = await Promise.allSettled([
    Promise.all([
      prom1(`avg by (node_slug) (${availability})`),
      prom1(`avg by (node_slug, probe) (${availability})`),
    ]).then(([nodes, byProbe]) => ({
      nodes: nodes.map((r) => ({ slug: r.metric.node_slug, ratio: num(r) })),
      byProbe: byProbe.map((r) => ({
        slug: r.metric.node_slug,
        probe: r.metric.probe,
        ratio: num(r),
      })),
    })),
    Promise.all([
      loki1(`sum(count_over_time(${sweep} [${tc.window}]))`),
      detail(`max(max_over_time(${sweep}${LAST_TS}))`),
      detail(
        `sum(count_over_time(${s.logs(L.throttleController)} |= "Error: " [1h]))`
      ),
    ]).then(([sweeps, lastSec, errorLines]) => ({
      sweeps,
      lastSec,
      errorLines,
    })),
    Promise.all([
      loki1(`sum(count_over_time(${backup} [${br.window}]))`),
      detail(`max(max_over_time(${backup}${LAST_TS}))`),
    ]).then(([receipts, lastSec]) => ({ receipts, lastSec })),
  ]);
  const ok = (r) => (r.status === "fulfilled" ? r.value : null);
  const errors = [a, c, b]
    .filter((r) => r.status === "rejected")
    .map((r) => String(r.reason?.message ?? r.reason));
  return {
    ...evaluateObjectives(
      { availability: ok(a), controller: ok(c), backups: ok(b) },
      nowSec,
      policyObjectives
    ),
    errors,
  };
}

const fresh = (sel) =>
  `(${sel} and (time() - timestamp(${sel}) <= ${TTL_SEC}))`;
const byService = (sel) =>
  `sum by (class, service) (max without (instance) (${sel}))`;

/**
 * One env: VM verdict plus guarded objectives. `deps` exists for tests:
 * `run(kind, expr)` replaces Grafana, `objectives` replaces policy.objectives.
 */
export async function snapshot(creds, env, nowSec, deps = {}) {
  const s = selectors(env);
  const run = deps.run ?? ((kind, expr) => query(creds, kind, expr, nowSec));
  const policyObjectives =
    "objectives" in deps ? deps.objectives : POLICY.objectives;
  const q = (expr) => run("prometheus", expr);
  const signalEntries = await Promise.all(
    Object.keys(POLICY.signals).map(async (key) => {
      const metric = SIGNAL_SERIES[key];
      if (!metric) return [key, []];
      const sel = `${metric}{${s.policy}}`;
      const [vals, stamps] = await Promise.all([
        q(sel),
        q(`timestamp(${sel})`),
      ]);
      const ts = new Map(stamps.map((r) => [labelKey(r.metric), num(r)]));
      return [
        key,
        vals.map((r) => ({
          host: r.metric.substrate_host,
          value: num(r),
          tsSec: ts.get(labelKey(r.metric)) ?? null,
        })),
      ];
    })
  );
  const familyEntries = await Promise.all(
    Object.entries(FAMILIES).map(async ([name, f]) => [
      name,
      (await q(`max by (substrate_host) (timestamp(${s.family(f)}))`)).map(
        (r) => ({ host: r.metric.substrate_host, tsSec: num(r) })
      ),
    ])
  );
  const bounds = serveProbeBounds(env);
  // timestamp() inside the subquery keeps each real sample time, so a probe that
  // runs less often than the 5m instant lookback still proves its last sample age.
  const [probeTs, probeNodes] = await Promise.all([
    q(`max(max_over_time(timestamp(${s.probe})[${bounds.window}:1m]))`),
    q(`min by (node_slug) (min_over_time(${s.probe}[${bounds.window}]))`),
  ]);
  const input = {
    nowSec,
    signals: Object.fromEntries(signalEntries),
    families: Object.fromEntries(familyEntries),
    probes: {
      ...bounds,
      tsSec: probeTs.length ? num(probeTs[0]) : null,
      nodes: probeNodes.map((r) => ({ slug: r.metric.node_slug, min: num(r) })),
    },
  };
  const result = evaluate(input);
  let detail = null;
  if (result.host) {
    const h = selectors(env, result.host).host;
    const one = async (expr) => {
      const r = await q(expr);
      return r.length ? num(r[0]) : null;
    };
    const rows = async (metric) =>
      (
        await q(
          byService(fresh(`${metric}{${h},class=~"compose|systemd|k8s"}`))
        )
      ).map((r) => ({
        class: r.metric.class,
        service: r.metric.service,
        bytes: num(r),
      }));
    const [memTotal, used, swapUsed, swapIn, rss, swap, faults] =
      await Promise.all([
        one(`max(node_memory_MemTotal_bytes{${h}})`),
        one(
          `max(node_memory_MemTotal_bytes{${h}} - node_memory_MemAvailable_bytes{${h}})`
        ),
        one(
          `max(node_memory_SwapTotal_bytes{${h}} - node_memory_SwapFree_bytes{${h}})`
        ),
        one(`max(rate(node_vmstat_pswpin{${h}}[5m]))`),
        rows("container_memory_rss"),
        rows("container_memory_swap"),
        q(
          `topk(5, ${byService(`rate(container_memory_failures_total{${h},failure_type="pgmajfault",class=~"compose|systemd|k8s"}[5m])`)} > 0)`
        ),
      ]);
    detail = {
      memTotalBytes: memTotal,
      usedBytes: used,
      swapUsedBytes: swapUsed,
      swapInPagesPerSec: swapIn,
      consumers: summarizeConsumers(rss, swap, used),
      majorFaultsPerSec: faults
        .map((r) => ({
          service: `${r.metric.class}/${r.metric.service}`,
          rate: num(r),
        }))
        .sort((a, b) => b.rate - a.rate),
    };
  }
  return {
    env,
    ...result,
    detail,
    objectives: await guardObjectives(() =>
      objectives(run, env, nowSec, policyObjectives)
    ),
  };
}

const fmt = (v, d = 1) => (finite(v) ? v.toFixed(d) : "n/a");
const gib = (b) => (finite(b) ? `${(b / 1073741824).toFixed(1)}GiB` : "n/a");
const mib = (b) => `${Math.round(b / 1048576)}MiB`;
const op = (g) => (g.direction === "above" ? "≥" : "≤");
const ICON = { GREEN: "🟢", YELLOW: "🟡", RED: "🔴", UNKNOWN: "⚪" };

export function render(s) {
  if (s.error)
    return `⚪ ${s.env.toUpperCase()} UNKNOWN — Grafana query failed (${s.error}); nothing about this VM is proven.`;
  const lines = [
    `${ICON[s.verdict]} ${s.env.toUpperCase()} ${s.verdict} — ${s.next[0]}`,
  ];
  for (const extra of s.next.slice(1)) lines.push(`   then: ${extra}`);
  lines.push(
    `   policy ${POLICY.version}: ${s.signals
      .map(
        (g) =>
          `${g.key} ${fmt(g.value)}${g.level === "GREEN" ? "" : ` ${ICON[g.level]}`} (warn ${op(g)}${g.warning}, crit ${op(g)}${g.critical})`
      )
      .join(" · ")}${s.host ? ` · host ${s.host.slice(0, 8)}` : ""}`
  );
  lines.push(
    `   evidence age: ${Object.entries(s.families)
      .map(([k, v]) => `${k} ${v === null ? "absent" : `${Math.round(v)}s`}`)
      .join(" · ")} (TTL ${TTL_SEC}s)`
  );
  for (const f of s.findings.filter(
    (x) => !(x.key in POLICY.signals) || x.level === "UNKNOWN"
  ))
    lines.push(`   ${ICON[f.level]} ${f.text}`);
  const d = s.detail;
  if (d) {
    const c = d.consumers;
    lines.push(
      `   detail (ungraded): RAM ${gib(d.memTotalBytes)} · used ${gib(d.usedBytes)} · swap used ${gib(d.swapUsedBytes)} · swap-in ${fmt(d.swapInPagesPerSec)} pages/s · outside per-service RSS ${gib(c.outsideRssBytes)} (shmem/tmpfs, slab, page tables, unnamed processes)`
    );
    if (c.top.length)
      lines.push(
        `   top rss+swap: ${c.top.map((t) => `${t.service} ${mib(t.rss)}${t.swap > 0 ? `+${mib(t.swap)}sw` : ""}`).join(" · ")}`
      );
    if (d.majorFaultsPerSec.length)
      lines.push(
        `   major faults/s: ${d.majorFaultsPerSec.map((f) => `${f.service} ${Number(f.rate.toPrecision(2))}`).join(" · ")}`
      );
  }
  const e = s.endpoints;
  lines.push(
    `   node endpoints (not VM): ${e.status === "UNKNOWN" ? "⚪ UNKNOWN" : e.status === "OK" ? "OK" : "🔴"} ${e.text}`
  );
  if (s.objectives) {
    lines.push(...renderObjectives(s.objectives));
    for (const err of s.objectives.errors ?? [])
      lines.push(`   ⚪ objective query failed: ${err}`);
  }
  return lines.join("\n");
}

/** Pure: exit code from VM verdicts only; objectives are never read (OBJECTIVES_ARE_NOT_VM). */
export function vmExitCode(snaps) {
  const rank = Math.max(...snaps.map((s) => RANK[s.verdict] ?? RANK.UNKNOWN));
  return rank === 0 ? 0 : rank === 1 ? 1 : 2;
}

export function parseArgs(args) {
  const envs = [];
  let json = false;
  for (const a of args) {
    if (a === "--json") json = true;
    else if (ENVS.includes(a)) envs.push(a);
    else
      throw new UsageError(
        `unknown argument ${JSON.stringify(a)}; envs: ${ENVS.join(", ")}; flags: --json`
      );
  }
  return { json, envs: envs.length ? [...new Set(envs)] : ENVS };
}

async function main() {
  let opts;
  let creds;
  try {
    opts = parseArgs(process.argv.slice(2));
    creds = loadCreds();
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(3);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const settled = await Promise.allSettled(
    opts.envs.map((env) => snapshot(creds, env, nowSec))
  );
  const snaps = settled.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : {
          env: opts.envs[i],
          verdict: "UNKNOWN",
          error: String(r.reason?.message ?? r.reason),
        }
  );
  const at = new Date(nowSec * 1000).toISOString();
  if (opts.json)
    console.log(
      JSON.stringify(
        { at, policyVersion: POLICY.version, snapshots: snaps },
        null,
        2
      )
    );
  else
    console.log(
      `VM health snapshot ${at} · graded by ${POLICY.version}\n${snaps.map(render).join("\n")}`
    );
  if (settled.some((r) => r.reason instanceof CredentialError)) process.exit(3);
  if (settled.every((r) => r.status === "rejected")) process.exit(4);
  process.exit(vmExitCode(snaps));
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(4);
  });
}
