// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/experiments/akash-blue-green/probe`
 * Purpose: spike.5001 public availability recorder. Requests a node's public `/version` at a
 *   fixed rate (default 2 req/s) across a blue/green release and classifies every request
 *   against ZERO_FAILED_REQUESTS: connection, TLS, timeout, 5xx/52x, other non-2xx, unreadable
 *   body, or a SHA outside the release's allowed set (incumbent + release).
 * Scope: read-only HTTPS GETs; does not create, spend, hold a credential, or own deployment
 *   policy. Each sample is appended to a JSONL file as it lands so evidence
 *   survives an interrupted run; the scorecard consumes that file.
 * Invariants:
 *   - ONE_DEFINITION: `classify()` is the only success rule; tests and scorecard share it.
 *   - FIXED_CADENCE: tick N fires at start + N*interval; a slow request never delays the next.
 *   - ALLOWED_SHA_SET: a 2xx whose buildSha is outside the allowed set is `wrong_sha`.
 * Side-effects: IO (network GETs, JSONL append, stdout summary).
 * Links: knowledge akash-promotion-north-star (Cutover experiment), work item spike.5001.
 * @internal — measurement code, not shipped to production
 */

import { Resolver } from "node:dns";
import { appendFileSync } from "node:fs";

import { Agent, fetch as undiciFetch } from "undici";

export type FailureClass =
  | "connection"
  | "tls"
  | "timeout"
  | "http_5xx"
  | "http_non2xx"
  | "invalid_body"
  | "wrong_sha";

export interface ProbeSample {
  readonly seq: number;
  /** ISO time the request was sent. */
  readonly at: string;
  readonly ok: boolean;
  readonly failure?: FailureClass | undefined;
  readonly status?: number | undefined;
  readonly sha?: string | undefined;
  readonly instanceId?: string | undefined;
  /** Cloudflare edge request id, when present; attributes a sample to an edge/colo. */
  readonly cfRay?: string | undefined;
  readonly latencyMs: number;
  readonly detail?: string | undefined;
}

export interface ClassifyInput {
  readonly error?: unknown;
  readonly status?: number;
  /** Parsed `/version` body; undefined when the body was not JSON. */
  readonly version?:
    | { readonly buildSha?: unknown; readonly sha?: unknown }
    | undefined;
  /** Accepted SHAs for this window. Empty means "any SHA is acceptable". */
  readonly allowedShas: readonly string[];
}

/** Served SHA from a `/version` body (`buildSha`, else legacy `sha`). Pure. */
export function servedSha(
  version: ClassifyInput["version"]
): string | undefined {
  const raw = version?.buildSha ?? version?.sha;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/** Map a thrown fetch error to connection, TLS, or timeout. Pure. */
export function classifyFetchError(error: unknown): FailureClass {
  const name = String((error as { name?: unknown })?.name ?? "");
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  const norm = (s: unknown) =>
    String(s ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_");
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })
    ?.cause;
  const hay = `_${norm(cause?.code ?? (error as { code?: unknown })?.code)}_${norm(
    cause?.message
  )}_${norm((error as { message?: unknown })?.message)}_`;
  if (hay.includes("TIMEOUT") || hay.includes("ETIMEDOUT")) return "timeout";
  const tlsTokens = [
    "CERT",
    "ERR_TLS",
    "ERR_SSL",
    "_TLS_",
    "_SSL_",
    "SELF_SIGNED",
    "UNABLE_TO_VERIFY",
    "EPROTO",
    "DEPTH_ZERO",
  ];
  return tlsTokens.some((t) => hay.includes(t)) ? "tls" : "connection";
}

/** The single definition of "this request succeeded". Pure. */
export function classify(input: ClassifyInput): {
  ok: boolean;
  failure?: FailureClass;
} {
  if (input.error !== undefined) {
    return { ok: false, failure: classifyFetchError(input.error) };
  }
  const status = input.status ?? 0;
  // 5xx covers origin 500-504 and Cloudflare's 520-530 origin-unreachable family.
  if (status >= 500) return { ok: false, failure: "http_5xx" };
  if (status < 200 || status >= 300) {
    return { ok: false, failure: "http_non2xx" };
  }
  const sha = servedSha(input.version);
  if (!sha) return { ok: false, failure: "invalid_body" };
  if (input.allowedShas.length > 0 && !input.allowedShas.includes(sha)) {
    return { ok: false, failure: "wrong_sha" };
  }
  return { ok: true };
}

export interface ProbeSummary {
  readonly total: number;
  readonly ok: number;
  readonly failures: number;
  readonly byClass: Readonly<Record<string, number>>;
  readonly shaCounts: Readonly<Record<string, number>>;
  readonly firstAt?: string | undefined;
  readonly lastAt?: string | undefined;
  readonly firstFailureAt?: string | undefined;
  /** Largest gap between consecutive sample send times; continuity evidence. */
  readonly maxGapMs: number;
}

export function summarize(samples: readonly ProbeSample[]): ProbeSummary {
  const sorted = [...samples].sort((a, b) => a.at.localeCompare(b.at));
  const byClass: Record<string, number> = {};
  const shaCounts: Record<string, number> = {};
  let ok = 0;
  let firstFailureAt: string | undefined;
  let maxGapMs = 0;
  let prev: number | undefined;
  for (const s of sorted) {
    const t = Date.parse(s.at);
    if (prev !== undefined) maxGapMs = Math.max(maxGapMs, t - prev);
    prev = t;
    if (s.ok) ok++;
    else {
      const k = s.failure ?? "unknown";
      byClass[k] = (byClass[k] ?? 0) + 1;
      firstFailureAt ??= s.at;
    }
    if (s.sha) shaCounts[s.sha] = (shaCounts[s.sha] ?? 0) + 1;
  }
  return {
    total: sorted.length,
    ok,
    failures: sorted.length - ok,
    byClass,
    shaCounts,
    firstAt: sorted[0]?.at,
    lastAt: sorted.at(-1)?.at,
    firstFailureAt,
    maxGapMs,
  };
}

export interface ProbeOptions {
  /** Public origin, e.g. https://spawny-boi.cogni-testing.org */
  readonly url: string;
  readonly allowedShas: readonly string[];
  readonly ratePerSec?: number;
  /** Omit to run until `signal` aborts. */
  readonly durationMs?: number;
  readonly requestTimeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly onSample?: (s: ProbeSample) => void;
}

export async function probeOnce(
  seq: number,
  opts: ProbeOptions
): Promise<ProbeSample> {
  const doFetch = opts.fetchImpl ?? fetch;
  const started = Date.now();
  const at = new Date(started).toISOString();
  const url = new URL("/version", opts.url);
  url.searchParams.set("probe", `${started}-${seq}`); // defeat any edge cache
  try {
    const res = await doFetch(url, {
      headers: { "cache-control": "no-cache" },
      redirect: "manual",
      signal: AbortSignal.timeout(opts.requestTimeoutMs ?? 5000),
    });
    let version: ClassifyInput["version"];
    try {
      version = (await res.json()) as ClassifyInput["version"];
    } catch {
      version = undefined;
    }
    const verdict = classify({
      status: res.status,
      version,
      allowedShas: opts.allowedShas,
    });
    const instanceId = (version as { instanceId?: unknown } | undefined)
      ?.instanceId;
    return {
      seq,
      at,
      ok: verdict.ok,
      ...(verdict.failure && { failure: verdict.failure }),
      status: res.status,
      ...(servedSha(version) && { sha: servedSha(version) }),
      ...(typeof instanceId === "string" && { instanceId }),
      ...(res.headers.get("cf-ray") && {
        cfRay: res.headers.get("cf-ray") ?? undefined,
      }),
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      seq,
      at,
      ok: false,
      failure: classifyFetchError(error),
      latencyMs: Date.now() - started,
      detail: String((error as Error)?.message ?? error).slice(0, 200),
    };
  }
}

/** Fixed-cadence loop. Resolves with every sample once the duration elapses or `signal` aborts. */
export async function runProbe(opts: ProbeOptions): Promise<ProbeSample[]> {
  const intervalMs = Math.round(1000 / (opts.ratePerSec ?? 2));
  const start = Date.now();
  const deadline =
    opts.durationMs === undefined
      ? Number.POSITIVE_INFINITY
      : start + opts.durationMs;
  const samples: ProbeSample[] = [];
  const inflight: Promise<void>[] = [];
  for (let seq = 0; ; seq++) {
    const due = start + seq * intervalMs;
    if (due >= deadline || opts.signal?.aborted) break;
    const wait = due - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (opts.signal?.aborted) break;
    inflight.push(
      probeOnce(seq, opts).then((s) => {
        samples.push(s);
        opts.onSample?.(s);
      })
    );
  }
  await Promise.all(inflight);
  return samples.sort((a, b) => a.seq - b.seq);
}

// ---- CLI ----
// pnpm tsx scripts/experiments/akash-blue-green/probe.ts \
//   --url https://<host> --allow-sha <incumbent> --allow-sha <release> --out <file.jsonl> [--duration-sec N]
// Without --duration-sec it runs until SIGINT/SIGTERM, then prints the summary.
// Exit 0 = zero failures, 1 = any failure, 2 = usage.
// --dns-server <ip> resolves the host via that public resolver instead of the local one (a
// local/VPN resolver can negatively cache a freshly published record for its whole TTL).

/** fetch whose connections resolve A records through `server`, bypassing the OS resolver. */
export function fetchViaDnsServer(server: string): typeof fetch {
  const resolver = new Resolver();
  resolver.setServers([server]);
  const dispatcher = new Agent({
    connect: {
      lookup: (hostname, options, callback) => {
        resolver.resolve4(hostname, (err, addrs) => {
          if (err || addrs.length === 0) {
            callback(err ?? new Error(`no A record for ${hostname}`), "", 4);
            return;
          }
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (e: null, a: object[]) => void)(
              null,
              addrs.map((address) => ({ address, family: 4 }))
            );
            return;
          }
          callback(null, addrs[0] ?? "", 4);
        });
      },
    },
  });
  return ((input: Parameters<typeof undiciFetch>[0], init?: RequestInit) =>
    undiciFetch(input, {
      ...(init as Parameters<typeof undiciFetch>[1]),
      dispatcher,
    })) as unknown as typeof fetch;
}

function parseArgs(argv: readonly string[]) {
  const out: {
    url?: string | undefined;
    allow: string[];
    file?: string | undefined;
    durationSec?: number | undefined;
    dnsServer?: string | undefined;
  } = {
    allow: [],
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i + 1];
    switch (argv[i]) {
      case "--url":
        out.url = v;
        i++;
        break;
      case "--allow-sha":
        if (v) out.allow.push(v);
        i++;
        break;
      case "--out":
        out.file = v;
        i++;
        break;
      case "--duration-sec":
        out.durationSec = Number(v);
        i++;
        break;
      case "--dns-server":
        out.dnsServer = v;
        i++;
        break;
      default:
        break;
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.url || !args.file || args.allow.length === 0) {
    console.error(
      "usage: probe.ts --url <origin> --allow-sha <sha> [--allow-sha <sha>] --out <file.jsonl> [--duration-sec N]"
    );
    process.exit(2);
  }
  const file = args.file;
  const ctrl = new AbortController();
  process.on("SIGINT", () => ctrl.abort());
  process.on("SIGTERM", () => ctrl.abort());
  runProbe({
    url: args.url,
    allowedShas: args.allow,
    signal: ctrl.signal,
    ...(args.dnsServer && { fetchImpl: fetchViaDnsServer(args.dnsServer) }),
    ...(args.durationSec && { durationMs: args.durationSec * 1000 }),
    onSample: (s) => {
      appendFileSync(file, `${JSON.stringify(s)}\n`);
      if (!s.ok) {
        console.log(
          `${s.at} FAIL ${s.failure} status=${s.status ?? "-"} sha=${s.sha ?? "-"}`
        );
      }
    },
  })
    .then((samples) => {
      const sum = summarize(samples);
      console.log(JSON.stringify(sum, null, 2));
      process.exit(sum.total > 0 && sum.failures === 0 ? 0 : 1);
    })
    .catch((e) => {
      console.error(e);
      process.exit(3);
    });
}
