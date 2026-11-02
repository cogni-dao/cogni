// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

// biome-ignore-all lint/suspicious/noConsole: dev harness; stdout is its evidence surface
// biome-ignore-all lint/style/noProcessEnv: dev harness reads its own tuning env

/**
 * LOCAL LIVE HARNESS for the node-deploy sequencer (task.5400). DEV ONLY.
 *
 * Runs the REAL `NodeDeploySequencer` with ConsolePayer (the dev wallet), a local docker Postgres for
 * the store, Cloudflare for the edge host `node-deploy-canary-dev.cognidao.org`, and a 2 req/s public
 * probe resolved through DoH. It reads the operator's REAL checked-in canary declarations.
 *
 *   npx tsx nodes/operator/app/scripts/node-deploy-local.ts scenario   # state, v1, v2, v3, forced loss
 *   npx tsx nodes/operator/app/scripts/node-deploy-local.ts teardown   # close EVERY dseq we made, delete DNS, drop pg
 *   npx tsx nodes/operator/app/scripts/node-deploy-local.ts status
 *
 * Safety: ConsolePayer refuses to open unless the key opens ONLY `AKASH_PROBE_ACCOUNT_ID`. Teardown
 * closes only dseqs recorded in OUR attempts table / key map. Secrets are read from env files and never
 * printed.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createAppDbClient } from "@cogni/db-client";
import postgres from "postgres";
import { AkashChainTruth } from "../src/adapters/server/node-deploy/akash-chain-truth.adapter";
import { CloudflareDnsRecords } from "../src/adapters/server/node-deploy/cloudflare-dns.adapter";
import { ConsolePayer } from "../src/adapters/server/node-deploy/console-payer.adapter";
import { FileStatePasswords } from "../src/adapters/server/node-deploy/dev-state-passwords";
import { HttpProbe } from "../src/adapters/server/node-deploy/http-probe.adapter";
import { PostgresNodeDeployStore } from "../src/adapters/server/node-deploy/postgres-store.adapter";
import { resolveWorkloadDeclaration } from "../src/features/node-deploy/declarations";
import { EdgeRouter } from "../src/features/node-deploy/edge";
import {
  DEFAULT_SEQUENCER_CONFIG,
  NodeDeploySequencer,
} from "../src/features/node-deploy/sequencer";

const WS = "/Users/derek/conductor/workspaces/cogni-template/spokane-v2";
const AKASH_ENV = `${WS}/.env.cogni`;
const CF_ENV = "/Users/derek/dev/cogni-template/.env.local";
const DIR = `${WS}/.context/node-deploy-local`;
const LOG = `${DIR}/run.jsonl`;
const REPO_SPEC = join(
  import.meta.dirname,
  "../../../../.cogni/repo-spec.yaml"
);
const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const ENV = "dev";
const HOST = "node-deploy-canary-dev.cognidao.org";
const PG_NAME = "nd-local-pg";
const PG_PORT = 55477;
const PG_URL = `postgres://postgres:ndlocal@127.0.0.1:${PG_PORT}/postgres`;
const SHAS = {
  v1: "1111111111111111111111111111111111111111",
  v2: "2222222222222222222222222222222222222222",
  v3: "3333333333333333333333333333333333333333",
};
const RETAIN_MS = Number(process.env.ND_RETAIN_MS ?? 120_000);

function envVar(file: string, key: string): string {
  const m = readFileSync(file, "utf8").match(
    new RegExp(`^(?:export )?${key}=(.*)$`, "m")
  );
  if (!m) throw new Error(`missing ${key} in ${file}`);
  return (m[1] as string).trim().replace(/^["']|["']$/g, "");
}

mkdirSync(DIR, { recursive: true });
const ev = (event: string, data: Record<string, unknown> = {}): void => {
  const line = { ts: new Date().toISOString(), event, ...data };
  appendFileSync(LOG, `${JSON.stringify(line)}\n`);
  console.log(JSON.stringify(line).slice(0, 400));
};

/** Sequencer logs: one JSON line each, into the evidence file and (compactly) the console. */
const seqLog = {
  info: (f: Record<string, unknown>, msg: string) => ev(msg, f),
  warn: (f: Record<string, unknown>, msg: string) =>
    ev(msg, { level: "warn", ...f }),
  error: (f: Record<string, unknown>, msg: string) =>
    ev(msg, { level: "error", ...f }),
};

function dockerPg(): void {
  const running = spawnSync("docker", ["ps", "-q", "-f", `name=${PG_NAME}`], {
    encoding: "utf8",
  });
  if (running.stdout.trim()) return;
  spawnSync("docker", ["rm", "-f", PG_NAME], { encoding: "utf8" });
  const r = spawnSync(
    "docker",
    [
      "run",
      "-d",
      "--name",
      PG_NAME,
      "-e",
      "POSTGRES_PASSWORD=ndlocal",
      "-p",
      `${PG_PORT}:5432`,
      "postgres:16-alpine",
    ],
    { encoding: "utf8" }
  );
  if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
}

async function migrate(): Promise<void> {
  const sql = postgres(PG_URL, { max: 1 });
  for (let i = 0; i < 40; i++) {
    try {
      await sql`select 1`;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const file = join(
    import.meta.dirname,
    "../src/adapters/server/db/migrations/0055_node_workloads.sql"
  );
  const exists =
    await sql`select to_regclass('public.node_workload_attempts') as t`;
  if (!exists[0]?.t) {
    for (const stmt of readFileSync(file, "utf8").split(
      "--> statement-breakpoint"
    ))
      if (stmt.trim()) await sql.unsafe(stmt);
    ev("migration_applied", { file: "0055_node_workloads.sql" });
  }
  await sql.end();
}

class Probe {
  samples: {
    t: number;
    status: number;
    sha?: string;
    ms: number;
    error?: string;
  }[] = [];
  private timer?: NodeJS.Timeout;
  private readonly http = new HttpProbe(5_000);
  start(): void {
    this.timer = setInterval(async () => {
      const t = Date.now();
      const r = await this.http.publicDoh(HOST, `/version?p=${t}`);
      let sha: string | undefined;
      try {
        sha = (JSON.parse(r.body) as { buildSha?: string }).buildSha;
      } catch {
        /* non-json */
      }
      this.samples.push({ t, status: r.status, sha, ms: r.ms, error: r.error });
    }, 500);
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
  summary(): Record<string, unknown> {
    const firstOk = this.samples.findIndex((s) => s.status === 200);
    const after = firstOk < 0 ? [] : this.samples.slice(firstOk);
    const bad = after.filter((s) => s.status < 200 || s.status > 299);
    const bySha: Record<string, number> = {};
    for (const s of after)
      bySha[s.sha ?? "none"] = (bySha[s.sha ?? "none"] ?? 0) + 1;
    return {
      totalSamples: this.samples.length,
      beforeFirstServe: firstOk < 0 ? this.samples.length : firstOk,
      afterFirstServe: after.length,
      failedAfterFirstServe: bad.length,
      failures: bad.slice(0, 20).map((s) => ({
        at: new Date(s.t).toISOString(),
        status: s.status,
        error: s.error,
      })),
      bySha,
      p95ms: after.map((s) => s.ms).sort((a, b) => a - b)[
        Math.floor(after.length * 0.95)
      ],
    };
  }
}

async function build() {
  dockerPg();
  await migrate();
  const apiKey = envVar(AKASH_ENV, "AKASH_PROBE_CONSOLE_API_KEY");
  const accountId = envVar(AKASH_ENV, "AKASH_PROBE_ACCOUNT_ID");
  const payer = await ConsolePayer.open({
    apiKey,
    expectedAccountId: accountId,
    keyMapFile: `${DIR}/console-keys.json`,
    excludeProviders: (process.env.ND_EXCLUDE_PROVIDERS ?? "")
      .split(",")
      .filter(Boolean),
    log: (event, data) => ev(`console_${event}`, data),
  });
  ev("payer_open", { accountOk: true });
  const db = createAppDbClient(PG_URL, { max: 4, applicationName: "nd_local" });
  const store = new PostgresNodeDeployStore(db);
  const dnsRecords = new CloudflareDnsRecords({
    apiToken: envVar(CF_ENV, "CLOUDFLARE_API_TOKEN"),
    zoneId: envVar(CF_ENV, "CLOUDFLARE_ZONE_ID"),
  });
  // DEV guard: ONLY the -dev canary host.
  const edge = new EdgeRouter(
    dnsRecords,
    /^node-deploy-canary-dev\.cognidao\.org$/
  );
  const sequencer = new NodeDeploySequencer({
    store,
    payer,
    edge,
    probe: new HttpProbe(),
    secrets: new FileStatePasswords(`${DIR}/secrets`),
    chain: new AkashChainTruth({ owner: accountId }),
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    },
    log: seqLog,
    config: {
      ...DEFAULT_SEQUENCER_CONFIG,
      namespace: "local-dev",
      environment: ENV,
      retainMs: RETAIN_MS,
    },
  });
  return { db, store, payer, dnsRecords, edge, sequencer, accountId };
}

async function release(
  store: PostgresNodeDeployStore,
  workload: string,
  sha: string
) {
  const spec = resolveWorkloadDeclaration({
    repoSpecText: readFileSync(REPO_SPEC, "utf8"),
    nodeId: NODE_ID,
    env: ENV,
    workload,
  });
  const { release: r } = await store.recordRelease({
    nodeId: NODE_ID,
    env: ENV,
    workload,
    sourceSha: sha,
    spec,
    createdBy: "local-harness",
  });
  ev("release_recorded", { workload, sourceSha: sha, releaseId: r.id });
  return r;
}

const key = (workload: string) => ({ nodeId: NODE_ID, env: ENV, workload });

async function until(
  label: string,
  fn: () => Promise<boolean>,
  maxMs: number,
  everyMs = 4_000
): Promise<number> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await fn()) {
      const took = Date.now() - t0;
      ev("converged", { label, ms: took });
      return took;
    }
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`${label}: not converged in ${maxMs}ms`);
}

async function scenario(): Promise<void> {
  const h = await build();
  const { store, sequencer, payer } = h;
  if ((await h.edge.current(HOST)) !== undefined) {
    throw new Error(
      `${HOST} already has a DNS record; refusing to adopt it in the local harness`
    );
  }
  const probe = new Probe();
  probe.start();
  const result: Record<string, unknown> = {};
  try {
    // 1. state up
    await release(store, "canary-db", SHAS.v1);
    result.stateUpMs = await until(
      "state_up",
      async () => {
        await sequencer.tick();
        return (await store.attemptsFor(key("canary-db"))).some(
          (a) => a.phase === "active"
        );
      },
      15 * 60_000
    );

    // 2. v1, v2, v3 blue/green
    for (const v of ["v1", "v2", "v3"] as const) {
      const t0 = Date.now();
      await release(store, "canary", SHAS[v]);
      await until(
        `app_${v}_active`,
        async () => {
          await sequencer.tick();
          const a = await store.attemptsFor(key("canary"));
          return (
            a.some(
              (x) => x.phase === "active" && x.releaseId === a[0]?.releaseId
            ) && a[0]?.phase === "active"
          );
        },
        20 * 60_000
      );
      result[`${v}ActiveMs`] = Date.now() - t0;
      // blue retained, then closed + confirmed by the janitor inside `tick`
      await until(
        `blue_retired_after_${v}`,
        async () => {
          await sequencer.tick();
          const a = await store.attemptsFor(key("canary"));
          return !a.some(
            (x) => x.phase === "retiring" || x.phase === "closing"
          );
        },
        RETAIN_MS + 10 * 60_000
      );
      ev("state_after", {
        v,
        attempts: (await store.attemptsFor(key("canary"))).map((a) => ({
          n: a.attempt,
          phase: a.phase,
          dseq: a.externalName,
          provider: a.provider,
        })),
      });
    }

    // 3. forced loss: close the active lease out of band, then let reconcile + step recover it
    const before = (await store.attemptsFor(key("canary"))).find(
      (a) => a.phase === "active"
    );
    if (!before?.externalName)
      throw new Error("no active canary lease to kill");
    const tKill = Date.now();
    const closed = await payer.closeAndVerify(before.externalName, 90_000);
    ev("forced_loss", {
      dseq: before.externalName,
      closed,
      atMs: Date.now() - tKill,
    });
    result.forcedLossDseq = before.externalName;
    // reconcile runs each 60 s in production; run it now plus on its real cadence below
    let lastReconcile = 0;
    await until(
      "recovered_after_loss",
      async () => {
        if (Date.now() - lastReconcile >= 60_000 || lastReconcile === 0) {
          lastReconcile = Date.now();
          await sequencer.reconcileAll();
        }
        await sequencer.tick();
        const a = await store.attemptsFor(key("canary"));
        return (
          a[0]?.phase === "active" && a[0]?.externalName !== before.externalName
        );
      },
      25 * 60_000
    );
    result.recoveryMs = Date.now() - tKill;
    await until(
      "blue_retired_after_recovery",
      async () => {
        await sequencer.tick();
        return !(await store.attemptsFor(key("canary"))).some(
          (x) => x.phase === "retiring" || x.phase === "closing"
        );
      },
      RETAIN_MS + 10 * 60_000
    );
    await new Promise((r) => setTimeout(r, 15_000));
  } finally {
    probe.stop();
    result.probe = probe.summary();
    ev("scenario_result", result);
  }
}

async function teardown(): Promise<void> {
  const accountId = envVar(AKASH_ENV, "AKASH_PROBE_ACCOUNT_ID");
  const payer = await ConsolePayer.open({
    apiKey: envVar(AKASH_ENV, "AKASH_PROBE_CONSOLE_API_KEY"),
    expectedAccountId: accountId,
    keyMapFile: `${DIR}/console-keys.json`,
  });
  const dseqs = new Set<string>();
  const keyFile = `${DIR}/console-keys.json`;
  if (existsSync(keyFile))
    for (const v of Object.values(
      JSON.parse(readFileSync(keyFile, "utf8")) as Record<
        string,
        { dseq: string }
      >
    ))
      dseqs.add(v.dseq);
  const chain = new AkashChainTruth({ owner: accountId });
  for (const dseq of dseqs) {
    const closed = await payer.closeAndVerify(dseq, 90_000);
    ev("teardown_close", {
      dseq,
      consoleClosed: closed,
      chainState: await chain.deploymentState(dseq),
    });
  }
  // DNS: delete ONLY the -dev canary record, directly (the sequencer's port has no delete).
  const cf = {
    token: envVar(CF_ENV, "CLOUDFLARE_API_TOKEN"),
    zone: envVar(CF_ENV, "CLOUDFLARE_ZONE_ID"),
  };
  const call = async (method: string, path: string) => {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${cf.zone}${path}`,
      {
        method,
        headers: { authorization: `Bearer ${cf.token}` },
      }
    );
    return (await res.json()) as {
      result?: { id: string; name: string }[] | { id: string };
    };
  };
  const found = (await call("GET", `/dns_records?name=${HOST}`)).result as {
    id: string;
    name: string;
  }[];
  for (const r of found ?? []) {
    if (r.name !== HOST) throw new Error(`refusing to delete ${r.name}`);
    await call("DELETE", `/dns_records/${r.id}`);
  }
  const after = (await call("GET", `/dns_records?name=${HOST}`))
    .result as unknown[];
  ev("dns_gone", { host: HOST, recordsAfter: after.length });
  spawnSync("docker", ["rm", "-f", PG_NAME]);
  ev("pg_removed", { name: PG_NAME });
  // Final readback: every deployment of this account that is still active (not only ours).
  const stillActive = [];
  for (const dseq of dseqs) {
    const o = await payer.observe({ cogniKey: "", externalName: dseq });
    if (o.found && o.resource?.state !== "closed") stillActive.push(dseq);
  }
  ev("teardown_ours_still_active", {
    count: stillActive.length,
    dseqs: stillActive,
  });
}

async function status(): Promise<void> {
  const h = await build();
  for (const w of ["canary-db", "canary"]) {
    const rows = await h.store.attemptsFor(key(w));
    console.log(
      w,
      JSON.stringify(
        rows.map((a) => ({
          n: a.attempt,
          phase: a.phase,
          dseq: a.externalName,
          provider: a.provider,
          error: a.error,
        }))
      )
    );
  }
}

const cmd = process.argv[2];
const main =
  cmd === "scenario"
    ? scenario
    : cmd === "teardown"
      ? teardown
      : cmd === "status"
        ? status
        : undefined;
if (!main) {
  console.error("usage: scenario | teardown | status");
  process.exit(2);
}
main()
  .then(() => process.exit(0))
  .catch((e: unknown) => {
    console.error("FAILED:", e instanceof Error ? e.message : e);
    ev("failed", { error: e instanceof Error ? e.message : String(e) });
    process.exit(1);
  });
