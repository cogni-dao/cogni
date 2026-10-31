// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/compute/akash-native-state.adapter`
 * Purpose: Bounded, keyless public LCD deployment/lease observations for verified receipts.
 * Scope: HTTP + validation only. Bootstrap supplies the public owner, never caller input.
 * Invariants: fixed GET origin; no credentials/retries; uint64 stays lossless; no closure verdict.
 * Side-effects: public HTTP reads; safe per-request boundary events through injected logger.
 * Links: bug.5556; served Akash 2.1.0, node 151b989a58f579ac08b688b325e0dfcc4b44fecb,
 *   chain-sdk 23a32e89d932c2a2e12e2d6383dcf6517e8399d7 proto/node/akash/{deployment/v1beta4,market/v1beta5}/query.proto;
 *   deployment/v1/deployment.proto, market/v1/{lease,filters}.proto; Cosmos v0.53.7-akash.2 pagination.proto.
 * @internal
 */
import { z } from "zod";
import type {
  AkashNativeObservation,
  NativeLeaseState,
  NativeReadErrorCode,
} from "@/types/akash-native-state";

const LCD = "https://api.akashnet.net";
const SOURCE = `${LCD}/akash/deployment/v1beta4+market/v1beta5`;
const MAX_BODY_BYTES = 1024 * 1024;
const UINT64_MAX = 18446744073709551615n;
const uint64 = z
  .union([
    z.string(),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String)
  .refine((v) => /^(0|[1-9][0-9]{0,19})$/.test(v) && BigInt(v) <= UINT64_MAX);
const uint32 = z
  .union([
    z.number(),
    z
      .string()
      .regex(/^(0|[1-9][0-9]{0,9})$/)
      .transform(Number),
  ])
  .pipe(z.number().int().min(0).max(4294967295));
const deploymentId = z.object({
  owner: z.string().min(1).max(128),
  dseq: uint64,
});
const leaseId = deploymentId.extend({
  gseq: uint32,
  oseq: uint32,
  provider: z.string().min(1).max(128),
  bseq: uint32,
});
const deploymentState = z.union([
  z.enum(["active", "closed"]),
  z.literal(1).transform(() => "active" as const),
  z.literal(2).transform(() => "closed" as const),
]);
const leaseState = z.union([
  z.enum(["active", "insufficient_funds", "closed", "reclaiming"]),
  z.literal(1).transform(() => "active" as const),
  z.literal(2).transform(() => "insufficient_funds" as const),
  z.literal(3).transform(() => "closed" as const),
  z.literal(4).transform(() => "reclaiming" as const),
]);
const deploymentResponse = z.object({
  deployment: z.object({ id: deploymentId, state: deploymentState }),
});
const leaseResponse = z.object({
  lease: z.object({ id: leaseId, state: leaseState }),
});
const pageResponse = z.object({
  leases: z.array(z.unknown()).max(100),
  pagination: z.object({
    next_key: z
      .string()
      .max(8192)
      .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/)
      .nullable(),
  }),
});

class NativeReadError extends Error {
  constructor(readonly code: NativeReadErrorCode) {
    super(code);
  }
}
const codeOf = (error: unknown): NativeReadErrorCode =>
  error instanceof NativeReadError ? error.code : "network_error";
const empty = (errorCode: NativeReadErrorCode): AkashNativeObservation => ({
  source: SOURCE,
  observedAt: null,
  deploymentState: null,
  deploymentCoverage: "unknown",
  deploymentObservedAt: null,
  leaseStates: [],
  leaseCoverage: "unknown",
  leasePages: [],
  errorCode,
});

/** Abort also bounds injected transports and body streams that do not honor fetch's signal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

async function boundedJson(
  response: Response,
  signal: AbortSignal
): Promise<unknown> {
  if (!response.body) throw new NativeReadError("invalid_response");
  const reader = response.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES) {
      throw new NativeReadError("response_too_large");
    }
    for (;;) {
      const { value, done } = await abortable(reader.read(), signal);
      if (signal.aborted) throw signal.reason;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES)
        throw new NativeReadError("response_too_large");
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      throw new NativeReadError("invalid_response");
    }
  } finally {
    cancel();
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export class AkashNativeStateReader {
  constructor(
    private readonly owner: string | undefined,
    private readonly fetcher: typeof fetch,
    private readonly log?: {
      info(fields: Record<string, unknown>, message: string): void;
    }
  ) {}

  /** Four workers share a deadline only for new native work; ledger/probe IO lives elsewhere. */
  async readMany(input: {
    dseqs: readonly string[];
    signal?: AbortSignal;
  }): Promise<Readonly<Record<string, AkashNativeObservation>>> {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(new NativeReadError("budget_exceeded")),
      8000
    );
    const signal = input.signal
      ? AbortSignal.any([deadline.signal, input.signal])
      : deadline.signal;
    const handles = [...new Set(input.dseqs)];
    const result: Record<string, AkashNativeObservation> = Object.create(null);
    let cursor = 0;
    try {
      await Promise.all(
        Array.from({ length: Math.min(4, handles.length) }, async () => {
          while (cursor < handles.length) {
            const dseq = handles[cursor++];
            if (dseq === undefined) break;
            if (!this.owner) {
              result[dseq] = empty("owner_unavailable");
              continue;
            }
            if (
              !/^(0|[1-9][0-9]{0,19})$/.test(dseq) ||
              BigInt(dseq) > UINT64_MAX
            ) {
              result[dseq] = empty("invalid_handle");
              continue;
            }
            if (signal.aborted) {
              result[dseq] = empty(
                deadline.signal.aborted ? "budget_exceeded" : "aborted"
              );
              continue;
            }
            result[dseq] = await this.readOne(this.owner, dseq, signal);
          }
        })
      );
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async get(
    path: string,
    params: Record<string, string>,
    parent: AbortSignal
  ): Promise<{ body: unknown; observedAt: string }> {
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new NativeReadError("timeout")),
      2000
    );
    const signal = AbortSignal.any([parent, timeout.signal]);
    const started = performance.now();
    let errorCode: NativeReadErrorCode | null = null;
    const url = new URL(path, LCD);
    url.search = new URLSearchParams(params).toString();
    try {
      if (signal.aborted) throw signal.reason;
      const response = await abortable(
        this.fetcher(url, {
          method: "GET",
          signal,
          redirect: "error",
          credentials: "omit",
          cache: "no-store",
        }),
        signal
      );
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        throw new NativeReadError("http_error");
      }
      const body = await boundedJson(response, signal);
      return { body, observedAt: new Date().toISOString() };
    } catch (error) {
      errorCode = signal.aborted
        ? signal.reason instanceof NativeReadError
          ? signal.reason.code
          : "aborted"
        : codeOf(error);
      throw new NativeReadError(errorCode);
    } finally {
      clearTimeout(timer);
      this.log?.info(
        {
          event: "akash_native_state.read",
          resource: path.includes("deployments") ? "deployment" : "leases",
          outcome: errorCode ? "error" : "success",
          errorCode,
          durationMs: Math.round(performance.now() - started),
        },
        "akash_native_state.read"
      );
    }
  }

  private async readOne(
    owner: string,
    dseq: string,
    signal: AbortSignal
  ): Promise<AkashNativeObservation> {
    let deployment: AkashNativeObservation["deploymentState"] = null;
    let deploymentObservedAt: string | null = null;
    let errorCode: NativeReadErrorCode | null = null;
    try {
      const response = await this.get(
        "/akash/deployment/v1beta4/deployments/info",
        { "id.owner": owner, "id.dseq": dseq },
        signal
      );
      const parsed = deploymentResponse.safeParse(response.body);
      if (!parsed.success) throw new NativeReadError("invalid_response");
      if (
        parsed.data.deployment.id.owner !== owner ||
        parsed.data.deployment.id.dseq !== dseq
      )
        throw new NativeReadError("identity_mismatch");
      deployment = parsed.data.deployment.state;
      deploymentObservedAt = response.observedAt;
    } catch (error) {
      errorCode = codeOf(error);
    }

    const leaseStates = new Map<string, NativeLeaseState>();
    const leasePages: { observedAt: string; count: number }[] = [];
    let leaseCoverage: AkashNativeObservation["leaseCoverage"] = "unknown";
    let key: string | null = null;
    const cursors = new Set<string>();
    try {
      for (let page = 0; page < 2; page++) {
        const response = await this.get(
          "/akash/market/v1beta5/leases/list",
          {
            "filters.owner": owner,
            "filters.dseq": dseq,
            "pagination.limit": "100",
            ...(key ? { "pagination.key": key } : {}),
          },
          signal
        );
        const parsed = pageResponse.safeParse(response.body);
        if (!parsed.success) throw new NativeReadError("invalid_response");
        let invalid = false;
        for (const row of parsed.data.leases) {
          const lease = leaseResponse.safeParse(row);
          if (!lease.success) {
            invalid = true;
            errorCode = "invalid_response";
            continue;
          }
          const { id, state } = lease.data.lease;
          if (id.owner !== owner || id.dseq !== dseq) {
            invalid = true;
            errorCode = "identity_mismatch";
            continue;
          }
          const identity = JSON.stringify(id);
          const previous = leaseStates.get(identity);
          if (previous && previous.state !== state) {
            // Discard conflicting observations; do not choose a preferred chain state.
            leaseStates.delete(identity);
            throw new NativeReadError("conflicting_read");
          }
          leaseStates.set(identity, {
            id,
            state,
            observedAt: response.observedAt,
          });
        }
        leasePages.push({
          observedAt: response.observedAt,
          count: parsed.data.leases.length,
        });
        leaseCoverage = "partial";
        if (invalid) break;
        key = parsed.data.pagination.next_key;
        if (key === null || key === "") {
          leaseCoverage = "complete";
          break;
        }
        if (cursors.has(key) || page === 1)
          throw new NativeReadError("pagination_incomplete");
        cursors.add(key);
      }
    } catch (error) {
      errorCode = codeOf(error);
    }
    const observedAt = leasePages.at(-1)?.observedAt ?? deploymentObservedAt;
    return {
      source: SOURCE,
      observedAt,
      deploymentState: deployment,
      deploymentCoverage: deploymentObservedAt ? "complete" : "unknown",
      deploymentObservedAt,
      leaseStates: [...leaseStates.values()],
      leaseCoverage,
      leasePages,
      errorCode,
    };
  }
}
