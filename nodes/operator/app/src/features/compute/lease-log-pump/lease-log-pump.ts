// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/lease-log-pump`
 * Purpose: One bounded poll cycle that makes "deployed via operator ⇒ logs in Loki" a
 *   structural property (bug.5240). Coverage enumerates from the actuator's allocation
 *   ledger — the durable receipt that proves the spend — so EVERY service of EVERY live
 *   lease is tailed with zero per-node configuration, whatever image it runs and whether or
 *   not it ever became Ready. Akash workloads have no Alloy and no daemonset; this pump is
 *   the control-plane counterpart, reading provider lease logs and pushing them to Loki.
 * Scope: Cycle orchestration + label assignment + cursor custody only. IO lives behind the
 *   three injected seams (sources, provider reader, Loki writer); wiring lives in the
 *   bootstrap; scheduling (interval, shutdown) belongs to the composition root.
 * Invariants:
 *   - EVERY_DEPLOYED_SERVICE_HAS_A_STREAM: the source list and each source's service names
 *     derive from the same records that deployed the workload. No allowlist, no opt-in.
 *   - TRUSTED_LABELS_OPERATOR_SIDE: `env`/`node`/`service`/`source` labels are stamped HERE,
 *     in the control plane, from ledger-derived identity. No push credential and no label
 *     authority ever enters a lease environment (supersedes the bug.5127 app-push lane).
 *   - FAIL_OPEN_PER_SOURCE: one unreachable provider or sick lease skips that source for the
 *     cycle and never wedges the rest. Observability must never block or break a deploy.
 *   - CURSORS_COMMIT_AFTER_PUSH: a stream's tail window advances only after Loki accepted
 *     EVERY chunk of THAT stream, so a failed push re-ships (at-least-once) instead of
 *     losing lines. Commit is per stream, never per cycle.
 *   - BOUNDED_PER_STREAM_PUSHES: each stream ships in its own push requests, chunked by line
 *     count and bytes, with bounded concurrency. One slow, oversized or rejected stream fails
 *     alone and never starves the others (bug.5516: one all-streams POST of ~7.4k lines
 *     failed `fetch failed` on 52/53 ticks and silenced lease logs fleet-wide).
 *   - SILENCE_IS_DETECTABLE: every newly seen stream gets one synthetic attach marker, so
 *     "no app output" and "pump never attached" are distinguishable in Loki.
 * Side-effects: none directly (IO via injected seams)
 * Links: @ports/akash-tx.port (AkashTxLeaseLogSources), ./tail-merge,
 *   adapters/server/observability/loki-push.adapter, bootstrap/lease-log-pump, bug.5240,
 *   bug.5516, task.5144, docs/spec/grafana-observability-access.md
 * @internal
 */

import { AkashTxLeaseLogSourcesOutputSchema } from "@/contracts/compute.akash-tx.v1.contract";
import type {
  AkashTxLeaseLogSource,
  AkashTxLeaseLogSources,
  LeaseLogStream,
  ProviderLeaseLogLine,
  ProviderLeaseLogReaderPort,
} from "@/ports";

import { mergeTail, serviceForLogName } from "./tail-merge";

/** Structural pino subset (mirrors AkashTxLogger; features never import pino). */
export interface LeaseLogPumpLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface LeaseLogPumpDeps {
  /** Raw actuator response; validated here against the shared v1 wire schema. */
  readonly sources: () => Promise<unknown>;
  readonly readLogs: ProviderLeaseLogReaderPort["read"];
  readonly push: (streams: readonly LeaseLogStream[]) => Promise<void>;
  readonly log: LeaseLogPumpLogger;
  readonly now?: () => Date;
  /** Lines requested per lease per poll. Default 500. */
  readonly tailLines?: number;
  /** Retained merge window per stream. Default 200. */
  readonly maxTail?: number;
  /** Max values per push request. Default 1000. */
  readonly maxPushLines?: number;
  /** Max approximate UTF-8 payload bytes per push request. Default 1 MB. */
  readonly maxPushBytes?: number;
  /** Streams pushed in parallel. Default 4. */
  readonly pushConcurrency?: number;
}

interface StreamCursor {
  tail: readonly string[];
  lastTsNs: bigint;
  attached: boolean;
  /** Tick this emitter was last present in a window — liveness, not shipping state. */
  lastSeenTick: number;
}

/** One stream ready to ship plus the cursor commit it earns on success. */
interface PendingStream {
  readonly stream: LeaseLogStream;
  readonly commit: () => void;
  readonly dseq: string;
  readonly emitter: string;
}

/** Ticks a pod-name cursor may go unseen before it is dropped (pod churn hygiene). */
const CURSOR_STALE_TICKS = 240;

/** Per-cycle counts for the pump's single structured log line. */
export interface LeaseLogPumpTickReport {
  readonly sources: number;
  readonly streams: number;
  /** Streams whose every chunk Loki accepted (cursor committed). */
  readonly pushedStreams: number;
  /** Streams with a failed chunk (cursor NOT committed; re-ships next cycle). */
  readonly failedStreams: number;
  /** Lines of the committed streams only. */
  readonly pushedLines: number;
  readonly skippedSources: number;
  /** True when at least one stream shipped this cycle. */
  readonly pushed: boolean;
}

const utf8 = new TextEncoder();

/** Approximate push-body bytes of one value: ts + UTF-8 line + JSON punctuation. */
function valueBytes(value: readonly [string, string]): number {
  return value[0].length + utf8.encode(value[1]).byteLength + 8;
}

/**
 * Split a stream's ordered values into push-sized chunks capped by line count and
 * approximate UTF-8 bytes. Order is preserved; a single over-cap line ships alone rather
 * than being dropped.
 */
export function chunkValues(
  values: LeaseLogStream["values"],
  maxLines: number,
  maxBytes: number
): LeaseLogStream["values"][] {
  const chunks: (readonly [string, string])[][] = [];
  let current: (readonly [string, string])[] = [];
  let bytes = 0;
  for (const value of values) {
    const size = valueBytes(value);
    if (
      current.length > 0 &&
      (current.length >= maxLines || bytes + size > maxBytes)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(value);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * Diagnosable shape of a push failure. undici reports every network failure as
 * `TypeError: fetch failed` with the real reason on `cause` (`code` such as
 * `UND_ERR_SOCKET`, `ECONNRESET`, `UND_ERR_CONNECT_TIMEOUT`); a timeout surfaces as
 * `TimeoutError`. The adapter never puts credentials in errors and request headers are not
 * part of either object, so these fields are safe to log.
 */
function describePushError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { causeMessage: "unknown" };
  const cause = (error as { cause?: unknown }).cause;
  const detail =
    typeof cause === "object" && cause !== null
      ? (cause as { code?: unknown; name?: unknown; message?: unknown })
      : undefined;
  return {
    errorName: error.name,
    causeMessage: error.message.slice(0, 300),
    causeCode: typeof detail?.code === "string" ? detail.code : undefined,
    causeName: typeof detail?.name === "string" ? detail.name : undefined,
    causeDetail:
      typeof detail?.message === "string"
        ? detail.message.slice(0, 300)
        : undefined,
  };
}

export class LeaseLogPump {
  private readonly cursors = new Map<string, StreamCursor>();
  private tick_ = 0;
  private readonly now: () => Date;
  private readonly tailLines: number;
  private readonly maxTail: number;
  private readonly maxPushLines: number;
  private readonly maxPushBytes: number;
  private readonly pushConcurrency: number;

  constructor(private readonly deps: LeaseLogPumpDeps) {
    this.now = deps.now ?? (() => new Date());
    this.tailLines = deps.tailLines ?? 500;
    // The retained tail must cover a full polled window: prefix-anchored tail-merge only
    // finds the shipped overlap when the tail is at least as long as the window, otherwise
    // every poll past maxTail lines re-ships the whole window (bug.5516).
    this.maxTail = Math.max(deps.maxTail ?? this.tailLines, this.tailLines);
    this.maxPushLines = Math.max(1, deps.maxPushLines ?? 1000);
    this.maxPushBytes = Math.max(1, deps.maxPushBytes ?? 1_000_000);
    this.pushConcurrency = Math.max(1, deps.pushConcurrency ?? 4);
  }

  /** One bounded cycle. Never throws: every failure is logged and absorbed. */
  async tick(): Promise<LeaseLogPumpTickReport> {
    this.tick_ += 1;
    let snapshot: AkashTxLeaseLogSources;
    try {
      // WIRE_IS_THE_CONTRACT: a drifted actuator fails loudly here, not mid-cycle.
      snapshot = AkashTxLeaseLogSourcesOutputSchema.parse(
        await this.deps.sources()
      );
    } catch (error) {
      this.deps.log.error(
        { causeMessage: error instanceof Error ? error.message : "unknown" },
        "lease_log_pump_sources_unavailable"
      );
      return {
        sources: 0,
        streams: 0,
        pushedStreams: 0,
        failedStreams: 0,
        pushedLines: 0,
        skippedSources: 0,
        pushed: false,
      };
    }

    const pending: PendingStream[] = [];
    let skippedSources = 0;

    for (const source of snapshot.sources) {
      try {
        const lines = await this.deps.readLogs({
          providerHostUri: source.providerHostUri,
          providerAccount: source.providerAccount,
          dseq: source.dseq,
          gseq: source.gseq,
          oseq: source.oseq,
          token: snapshot.token,
          tail: this.tailLines,
        });
        this.collect(source, lines, pending);
      } catch (error) {
        skippedSources += 1;
        this.deps.log.warn(
          {
            node: source.nodeId,
            workload: source.workload,
            env: source.environment,
            dseq: source.dseq,
            causeMessage: error instanceof Error ? error.message : "unknown",
          },
          "lease_log_pump_source_read_failed"
        );
      }
    }

    this.pruneCursors(snapshot.sources);

    const shipped = await this.pushAll(pending);

    const report: LeaseLogPumpTickReport = {
      sources: snapshot.sources.length,
      streams: pending.length,
      pushedStreams: shipped.pushedStreams,
      failedStreams: pending.length - shipped.pushedStreams,
      pushedLines: shipped.pushedLines,
      skippedSources,
      pushed: shipped.pushedStreams > 0,
    };
    this.deps.log.info({ ...report }, "lease_log_pump_tick");
    return report;
  }

  private collect(
    source: AkashTxLeaseLogSource,
    lines: readonly ProviderLeaseLogLine[],
    pending: PendingStream[]
  ): void {
    const byEmitter = new Map<string, string[]>();
    for (const line of lines) {
      const existing = byEmitter.get(line.name);
      if (existing) existing.push(line.message);
      else byEmitter.set(line.name, [line.message]);
    }

    for (const [name, window] of byEmitter) {
      const service = serviceForLogName(name, source.services);
      const key = `${source.dseq}/${name}`;
      const cursor = this.cursors.get(key) ?? {
        tail: [],
        lastTsNs: 0n,
        attached: false,
        lastSeenTick: this.tick_,
      };
      // Liveness touch even when nothing new ships — a quiet stream is not a stale one.
      cursor.lastSeenTick = this.tick_;
      this.cursors.set(key, cursor);
      const merged = mergeTail(cursor.tail, window, this.maxTail);
      const attachLine = cursor.attached
        ? undefined
        : JSON.stringify({
            event: "lease_log_pump_attached",
            dseq: source.dseq,
            emitter: name,
            service,
          });
      if (merged.newLines.length === 0 && !attachLine) continue;

      const values: (readonly [string, string])[] = [];
      let tsNs = cursor.lastTsNs;
      const baseNs = BigInt(this.now().getTime()) * 1_000_000n;
      for (const line of attachLine
        ? [attachLine, ...merged.newLines]
        : merged.newLines) {
        tsNs = baseNs > tsNs ? baseNs : tsNs + 1n;
        values.push([tsNs.toString(), line] as const);
      }

      // STABLE_CONTEXT_ENVELOPE: few, low-cardinality, immutable-valued labels only
      // (Grafana Loki label guidance; OTel resource-attribute split). `node` (repo-spec
      // UUID) is the identity key; the renameable slug is registry-resolvable and
      // deliberately NOT a label; `service_name` mirrors `service` exactly as the k8s
      // lane does (container name), never a second identity axis. No `stream` label —
      // the provider merges stdout/stderr and the envelope must not assert otherwise.
      const committedTs = tsNs;
      pending.push({
        stream: {
          labels: {
            app: "cogni-template",
            env: source.environment,
            node: source.nodeId,
            service,
            service_name: service,
            source: "lease",
          },
          values,
        },
        commit: () => {
          this.cursors.set(key, {
            tail: merged.nextTail,
            lastTsNs: committedTs,
            attached: true,
            lastSeenTick: this.tick_,
          });
        },
        dseq: source.dseq,
        emitter: name,
      });
    }
  }

  /** Ship every pending stream through a small worker pool. Never throws. */
  private async pushAll(
    pending: readonly PendingStream[]
  ): Promise<{ pushedStreams: number; pushedLines: number }> {
    let next = 0;
    let pushedStreams = 0;
    let pushedLines = 0;
    const worker = async (): Promise<void> => {
      for (let item = pending[next++]; item; item = pending[next++]) {
        if (await this.pushStream(item)) {
          pushedStreams += 1;
          pushedLines += item.stream.values.length;
        }
      }
    };
    const workers = Math.min(this.pushConcurrency, pending.length);
    await Promise.all(Array.from({ length: workers }, worker));
    return { pushedStreams, pushedLines };
  }

  /**
   * Push one stream in bounded chunks; commit its cursor only if every chunk lands. A failed
   * chunk stops this stream (later chunks would land out of order) and leaves its cursor
   * untouched, so the next cycle re-ships it (CURSORS_COMMIT_AFTER_PUSH).
   */
  private async pushStream(item: PendingStream): Promise<boolean> {
    const { labels, values } = item.stream;
    const chunks = chunkValues(values, this.maxPushLines, this.maxPushBytes);
    for (const [index, chunk] of chunks.entries()) {
      try {
        await this.deps.push([{ labels, values: chunk }]);
      } catch (error) {
        this.deps.log.error(
          {
            node: labels.node,
            env: labels.env,
            service: labels.service,
            dseq: item.dseq,
            emitter: item.emitter,
            chunk: index + 1,
            chunks: chunks.length,
            lines: chunk.length,
            bytes: chunk.reduce((n, value) => n + valueBytes(value), 0),
            streamLines: values.length,
            ...describePushError(error),
          },
          "lease_log_pump_push_failed"
        );
        return false;
      }
    }
    item.commit();
    return true;
  }

  /**
   * Drop cursors for leases no longer enumerated (closed leases must not pin memory) and
   * for emitters unseen for CURSOR_STALE_TICKS (pod churn inside a long-lived lease).
   */
  private pruneCursors(sources: readonly AkashTxLeaseLogSource[]): void {
    const live = new Set(sources.map((s) => s.dseq));
    for (const [key, cursor] of this.cursors) {
      const dseq = key.slice(0, key.indexOf("/"));
      if (
        !live.has(dseq) ||
        this.tick_ - cursor.lastSeenTick > CURSOR_STALE_TICKS
      ) {
        this.cursors.delete(key);
      }
    }
  }
}
