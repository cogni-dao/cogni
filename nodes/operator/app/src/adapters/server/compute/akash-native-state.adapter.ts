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
  AkashNativeWalletInventory,
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
        Array.from({ length: Math.min(2, handles.length) }, async () => {
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
    parent: AbortSignal,
    height?: string
  ): Promise<{ body: unknown; observedAt: string; height: string | null }> {
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
          ...(height ? { headers: { "x-cosmos-block-height": height } } : {}),
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
      const servedHeight = response.headers.get("x-cosmos-block-height");
      if (height && servedHeight !== height)
        throw new NativeReadError("height_mismatch");
      return {
        body,
        observedAt: new Date().toISOString(),
        height: servedHeight,
      };
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

  /** Owner filtering walks historical primary keys. Only real continuation exhaustion completes. */
  async readWalletInventory(input: {
    signal?: AbortSignal;
    deadlineAt: number;
  }): Promise<AkashNativeWalletInventory> {
    if (!this.owner) throw new NativeReadError("owner_unavailable");
    const owner = this.owner;
    const { signal, clear } = this.inventoryDeadline(input);
    try {
      let height: string | undefined;
      const deployments = await this.inventoryPages(
        "/akash/deployment/v1beta4/deployments/list",
        {
          "filters.owner": owner,
          "filters.state": "active",
        },
        "deployments",
        signal,
        () => height,
        (value) => {
          height = value;
        }
      );
      const targets: AkashNativeWalletInventory["targets"][number][] = [];
      let facts = 0;
      const seen = new Set<string>();
      for (const raw of deployments) {
        if (signal.aborted) throw signal.reason;
        const parsed = deploymentResponse
          .extend({
            groups: z
              .array(
                z.object({
                  id: deploymentId.extend({ gseq: uint32 }),
                  state: z.enum([
                    "open",
                    "paused",
                    "insufficient_funds",
                    "closed",
                  ]),
                })
              )
              .min(1)
              .max(100),
          })
          .safeParse(raw);
        if (!parsed.success) throw new NativeReadError("invalid_response");
        const { id, state } = parsed.data.deployment;
        if (id.owner !== owner || state !== "active" || seen.has(id.dseq))
          throw new NativeReadError("identity_mismatch");
        seen.add(id.dseq);
        const groups = parsed.data.groups.map((group) => {
          if (group.id.owner !== owner || group.id.dseq !== id.dseq)
            throw new NativeReadError("identity_mismatch");
          return { gseq: group.id.gseq, state: group.state };
        });
        if (new Set(groups.map((group) => group.gseq)).size !== groups.length)
          throw new NativeReadError("conflicting_read");
        const params = { "filters.owner": owner, "filters.dseq": id.dseq };
        const ordersRaw = await this.inventoryPages(
          "/akash/market/v1beta5/orders/list",
          params,
          "orders",
          signal,
          () => height
        );
        const orders = ordersRaw.map((rawOrder) => {
          const order = z
            .object({
              id: deploymentId.extend({ gseq: uint32, oseq: uint32 }),
              state: z.enum(["open", "active", "closed"]),
            })
            .safeParse(rawOrder);
          if (!order.success) throw new NativeReadError("invalid_response");
          const { id: orderId, state: orderState } = order.data;
          if (
            orderId.owner !== owner ||
            orderId.dseq !== id.dseq ||
            !groups.some((group) => group.gseq === orderId.gseq)
          )
            throw new NativeReadError("identity_mismatch");
          return { gseq: orderId.gseq, oseq: orderId.oseq, state: orderState };
        });
        const leasesRaw = await this.inventoryPages(
          "/akash/market/v1beta5/leases/list",
          params,
          "leases",
          signal,
          () => height
        );
        const leases = leasesRaw.map((rawLease) => {
          const lease = leaseResponse.safeParse(rawLease);
          if (!lease.success) throw new NativeReadError("invalid_response");
          if (
            lease.data.lease.id.owner !== owner ||
            lease.data.lease.id.dseq !== id.dseq ||
            !groups.some((group) => group.gseq === lease.data.lease.id.gseq)
          )
            throw new NativeReadError("identity_mismatch");
          return { ...lease.data.lease, observedAt: new Date().toISOString() };
        });
        if (
          new Set(orders.map((order) => `${order.gseq}/${order.oseq}`)).size !==
            orders.length ||
          new Set(leases.map((lease) => JSON.stringify(lease.id))).size !==
            leases.length
        )
          throw new NativeReadError("conflicting_read");
        facts += groups.length + orders.length + leases.length;
        if (facts > 10_000) throw new NativeReadError("inventory_overflow");
        targets.push({ dseq: id.dseq, groups, orders, leases });
      }
      if (!height || signal.aborted)
        throw new NativeReadError("budget_exceeded");
      return { owner, height, observedAt: new Date().toISOString(), targets };
    } finally {
      clear();
    }
  }

  async readOwnClosed(input: {
    dseq: string;
    signal?: AbortSignal;
    deadlineAt: number;
  }): Promise<{
    owner: string;
    dseq: string;
    height: string;
    closed: boolean;
  }> {
    if (!this.owner || !uint64.safeParse(input.dseq).success)
      throw new NativeReadError("invalid_handle");
    const { signal, clear } = this.inventoryDeadline(input);
    try {
      const response = await this.get(
        "/akash/deployment/v1beta4/deployments/info",
        { "id.owner": this.owner, "id.dseq": input.dseq },
        signal
      );
      const parsed = deploymentResponse.safeParse(response.body);
      if (
        !parsed.success ||
        !response.height ||
        !/^[1-9][0-9]*$/.test(response.height)
      )
        throw new NativeReadError("invalid_response");
      if (
        signal.aborted ||
        parsed.data.deployment.id.owner !== this.owner ||
        parsed.data.deployment.id.dseq !== input.dseq
      )
        throw new NativeReadError("identity_mismatch");
      return {
        owner: this.owner,
        dseq: input.dseq,
        height: response.height,
        closed: parsed.data.deployment.state === "closed",
      };
    } finally {
      clear();
    }
  }

  private inventoryDeadline(input: {
    signal?: AbortSignal;
    deadlineAt: number;
  }) {
    const deadline = new AbortController();
    const remaining = Math.min(30_000, input.deadlineAt - Date.now());
    if (remaining <= 0) deadline.abort(new NativeReadError("budget_exceeded"));
    const timer = setTimeout(
      () => deadline.abort(new NativeReadError("budget_exceeded")),
      Math.max(0, remaining)
    );
    return {
      signal: input.signal
        ? AbortSignal.any([deadline.signal, input.signal])
        : deadline.signal,
      clear: () => clearTimeout(timer),
    };
  }

  private async inventoryPages(
    path: string,
    params: Record<string, string>,
    field: "deployments" | "orders" | "leases",
    signal: AbortSignal,
    height: () => string | undefined,
    setHeight?: (height: string) => void
  ): Promise<unknown[]> {
    const result: unknown[] = [];
    let key: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      if (signal.aborted) throw signal.reason;
      const response = await this.get(
        path,
        {
          ...params,
          "pagination.limit": "100",
          ...(key ? { "pagination.key": key } : {}),
        },
        signal,
        height()
      );
      if (
        !response.height ||
        !/^[1-9][0-9]*$/.test(response.height) ||
        (height() && height() !== response.height)
      )
        throw new NativeReadError("height_mismatch");
      if (!height()) setHeight?.(response.height);
      const parsed = z
        .object({ pagination: pageResponse.shape.pagination })
        .safeParse(response.body);
      const object = z.record(z.string(), z.unknown()).safeParse(response.body);
      if (!parsed.success || !object.success)
        throw new NativeReadError("invalid_response");
      const decoded = z
        .array(z.unknown())
        .max(100)
        .safeParse(object.data[field]);
      if (!decoded.success) throw new NativeReadError("invalid_response");
      const rows = decoded.data;
      result.push(...rows);
      if (result.length > 10_000)
        throw new NativeReadError("inventory_overflow");
      key = parsed.data.pagination.next_key;
      if (!key) return result;
      if (cursors.has(key)) throw new NativeReadError("pagination_incomplete");
      cursors.add(key);
    }
    throw new NativeReadError("inventory_overflow");
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
        // Retained rows belong to this page even if a later row conflicts and exits.
        leasePages.push({
          observedAt: response.observedAt,
          count: parsed.data.leases.length,
        });
        leaseCoverage = "partial";
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
