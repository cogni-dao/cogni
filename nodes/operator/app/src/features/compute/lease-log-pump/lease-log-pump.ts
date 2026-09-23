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
 *   - CURSORS_COMMIT_AFTER_PUSH: tail windows advance only after Loki accepted the batch, so
 *     a failed push re-ships (at-least-once) instead of losing lines.
 *   - SILENCE_IS_DETECTABLE: every newly seen stream gets one synthetic attach marker, so
 *     "no app output" and "pump never attached" are distinguishable in Loki.
 * Side-effects: none directly (IO via injected seams)
 * Links: @ports/akash-tx.port (AkashTxLeaseLogSources), ./tail-merge,
 *   adapters/server/observability/loki-push.adapter, bootstrap/lease-log-pump, bug.5240,
 *   task.5144, docs/spec/grafana-observability-access.md
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
}

interface StreamCursor {
  tail: readonly string[];
  lastTsNs: bigint;
  attached: boolean;
  /** Tick this emitter was last present in a window — liveness, not shipping state. */
  lastSeenTick: number;
}

/** Ticks a pod-name cursor may go unseen before it is dropped (pod churn hygiene). */
const CURSOR_STALE_TICKS = 240;

/** Per-cycle counts for the pump's single structured log line. */
export interface LeaseLogPumpTickReport {
  readonly sources: number;
  readonly streams: number;
  readonly pushedLines: number;
  readonly skippedSources: number;
  readonly pushed: boolean;
}

export class LeaseLogPump {
  private readonly cursors = new Map<string, StreamCursor>();
  private tick_ = 0;
  private readonly now: () => Date;
  private readonly tailLines: number;
  private readonly maxTail: number;

  constructor(private readonly deps: LeaseLogPumpDeps) {
    this.now = deps.now ?? (() => new Date());
    this.tailLines = deps.tailLines ?? 500;
    this.maxTail = deps.maxTail ?? 200;
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
        pushedLines: 0,
        skippedSources: 0,
        pushed: false,
      };
    }

    const streams: LeaseLogStream[] = [];
    const commits: (() => void)[] = [];
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
        this.collect(source, lines, streams, commits);
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

    const pushedLines = streams.reduce((n, s) => n + s.values.length, 0);
    let pushed = false;
    if (streams.length > 0) {
      try {
        await this.deps.push(streams);
        for (const commit of commits) commit();
        pushed = true;
      } catch (error) {
        // CURSORS_COMMIT_AFTER_PUSH: nothing committed; the next cycle re-merges and re-ships.
        this.deps.log.error(
          {
            streams: streams.length,
            lines: pushedLines,
            causeMessage: error instanceof Error ? error.message : "unknown",
          },
          "lease_log_pump_push_failed"
        );
      }
    }

    const report: LeaseLogPumpTickReport = {
      sources: snapshot.sources.length,
      streams: streams.length,
      pushedLines: pushed ? pushedLines : 0,
      skippedSources,
      pushed,
    };
    this.deps.log.info({ ...report }, "lease_log_pump_tick");
    return report;
  }

  private collect(
    source: AkashTxLeaseLogSource,
    lines: readonly ProviderLeaseLogLine[],
    streams: LeaseLogStream[],
    commits: (() => void)[]
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
      streams.push({
        labels: {
          app: "cogni-template",
          env: source.environment,
          node: source.nodeId,
          service,
          service_name: service,
          source: "lease",
        },
        values,
      });
      const committedTs = tsNs;
      commits.push(() => {
        this.cursors.set(key, {
          tail: merged.nextTail,
          lastTsNs: committedTs,
          attached: true,
          lastSeenTick: this.tick_,
        });
      });
    }
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
