// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/console-payer.adapter`
 * Purpose: ConsolePayer — the DEV-ONLY `PayerPort`. Pays straight from the Akash Console managed-wallet
 *   API so the REAL sequencer can be run locally against the dev wallet before CI (task.5400). It is
 *   the prototype's console client behind the same port the production ActuatorPayer implements.
 * Scope: create (deployment -> screened bid -> lease), observe, delete. NOT wired by any production
 *   bootstrap: only `scripts/node-deploy-local.ts` constructs it.
 * Invariants:
 *   - ONLY_THE_PROBE_ACCOUNT: `ConsolePayer.open` refuses to return unless the key opens EXACTLY ONE
 *     wallet account and it equals `AKASH_PROBE_ACCOUNT_ID`. A production credential can never be
 *     used by accident.
 *   - IDEMPOTENT_BY_KEY: `cogniKey -> dseq` is persisted (file) the moment the deployment exists, so
 *     `observe(cogniKey)` and a replayed `create` find it after a crash.
 *   - FAIL_CLOSED_ON_LEASE_FAILURE: a deployment that cannot be leased is closed and read back closed
 *     before the failure is thrown (non-ambiguous: nothing is billing).
 *   - NO_SECRETS_IN_ERRORS: errors carry status + a short body digest, never the SDL or the key.
 * Side-effects: IO (HTTPS to console-api.akash.network; one small JSON file)
 * @internal
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import type { ProvisionSpec } from "@cogni/ai-tools";

import {
  type PayerCreateRequest,
  PayerError,
  type PayerPort,
  type PayerResource,
} from "@/ports";

import { buildAkashSdl } from "../compute/akash-sdl";

export const OVERCLOCK_AUDITOR = "akash1365yvmc4s7awdyj3n2sav7xfx76adc6dnmlx63";

type Json = Record<string, unknown>;

class ConsoleHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

interface Bid {
  readonly dseq: string;
  readonly gseq: number;
  readonly oseq: number;
  readonly provider: string;
  readonly state: string;
  readonly denom: string;
  readonly amount: number;
}

interface ProviderInfo {
  readonly owner: string;
  readonly isOnline: boolean;
  readonly isAudited: boolean;
  readonly customDomain: boolean | null;
}

interface DeploymentView {
  readonly state: string;
  readonly owner: string | undefined;
  readonly leases: readonly {
    readonly state: string;
    readonly provider: string;
    readonly uris: readonly string[];
    readonly forwarded: readonly {
      host: string;
      externalPort: number;
      proto: string;
    }[];
  }[];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ConsolePayerConfig {
  readonly apiKey: string;
  /** `AKASH_PROBE_ACCOUNT_ID`: the only account this payer may open. */
  readonly expectedAccountId: string;
  /** JSON file holding `cogniKey -> dseq`. */
  readonly keyMapFile: string;
  readonly baseUrl?: string;
  readonly pricingDenom?: string;
  readonly pricingAmount?: number;
  readonly depositUsd?: number;
  readonly bidMs?: number;
  readonly bidGraceMs?: number;
  /** Providers never offered a bid (dev diagnostics, e.g. a state lease's own provider). */
  readonly excludeProviders?: readonly string[];
  readonly log?: (event: string, data?: Record<string, unknown>) => void;
}

export class ConsolePayer implements PayerPort {
  private readonly base: string;
  private keys: Record<string, { dseq: string; provider?: string }>;

  private constructor(private readonly cfg: ConsolePayerConfig) {
    this.base = cfg.baseUrl ?? "https://console-api.akash.network";
    this.keys = existsSync(cfg.keyMapFile)
      ? (JSON.parse(readFileSync(cfg.keyMapFile, "utf8")) as typeof this.keys)
      : {};
  }

  /** Verify the key opens ONLY the expected account, then return the payer. */
  static async open(cfg: ConsolePayerConfig): Promise<ConsolePayer> {
    if (!cfg.expectedAccountId)
      throw new Error("ConsolePayer: AKASH_PROBE_ACCOUNT_ID is required");
    const payer = new ConsolePayer(cfg);
    const me = await payer.http<{ id?: string }>("GET", "/v1/user/me");
    if (!me?.id) throw new Error("ConsolePayer: /v1/user/me returned no id");
    const wallets = await payer.http<{ address?: string }[]>(
      "GET",
      `/v1/wallets?userId=${encodeURIComponent(me.id)}`
    );
    const accounts = (wallets ?? [])
      .map((w) => String(w.address ?? ""))
      .filter(Boolean);
    if (accounts.length !== 1 || accounts[0] !== cfg.expectedAccountId)
      throw new Error(
        `ConsolePayer: key opens [${accounts.join(", ")}], must open ONLY ${cfg.expectedAccountId}; refusing to start`
      );
    return payer;
  }

  // ---- HTTP ---------------------------------------------------------------------------------

  private async http<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = method === "GET" ? 30_000 : 120_000
  ): Promise<T | undefined> {
    const attempts = method === "GET" ? 3 : 1;
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await fetch(`${this.base}${path}`, {
          method,
          headers: {
            "x-api-key": this.cfg.apiKey,
            accept: "application/json",
            ...(body !== undefined
              ? { "content-type": "application/json" }
              : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (!res.ok)
          throw new ConsoleHttpError(
            res.status,
            `Console ${method} ${path.split("?")[0]} -> HTTP ${res.status} ${text.slice(0, 200)}`
          );
        if (!text) return undefined;
        const json = JSON.parse(text) as Json;
        return (
          json && typeof json === "object" && "data" in json ? json.data : json
        ) as T;
      } catch (e) {
        last = e;
        if (e instanceof ConsoleHttpError && e.status > 0 && e.status < 500)
          throw e;
        if (i < attempts - 1) await sleep(1000 * (i + 1));
      }
    }
    throw last instanceof ConsoleHttpError
      ? last
      : new ConsoleHttpError(
          0,
          `Console ${method} ${path.split("?")[0]} network error`
        );
  }

  private persist(): void {
    writeFileSync(this.cfg.keyMapFile, JSON.stringify(this.keys, null, 2), {
      mode: 0o600,
    });
  }

  // ---- views --------------------------------------------------------------------------------

  private async view(dseq: string): Promise<DeploymentView | null> {
    try {
      const d = await this.http<Json>(
        "GET",
        `/v1/deployments/${encodeURIComponent(dseq)}`
      );
      if (!d) return null;
      const dep = (d.deployment ?? {}) as Json;
      const id = (dep.id ?? {}) as Json;
      const leases = ((d.leases ?? []) as Json[]).map((l) => {
        const lid = (l.id ?? {}) as Json;
        const status = (l.status ?? {}) as Json;
        const services = (status.services ?? {}) as Record<string, Json>;
        const uris = Object.values(services).flatMap((s) =>
          ((s.uris ?? []) as string[]).map(String)
        );
        const fp = (status.forwarded_ports ?? {}) as Record<string, Json[]>;
        const forwarded = Object.values(fp).flatMap((ports) =>
          (ports ?? []).map((p) => ({
            host: String(p.host ?? ""),
            externalPort: Number(p.externalPort ?? 0),
            proto: String(p.proto ?? "TCP"),
          }))
        );
        return {
          state: String(l.state ?? ""),
          provider: String(lid.provider ?? ""),
          uris,
          forwarded,
        };
      });
      return {
        state: String(dep.state ?? ""),
        owner: typeof id.owner === "string" ? id.owner : undefined,
        leases,
      };
    } catch (e) {
      if (e instanceof ConsoleHttpError && e.status === 404) return null;
      throw e;
    }
  }

  private toResource(dseq: string, v: DeploymentView): PayerResource {
    const active = v.leases.find((l) => l.state === "active");
    const endpoints = (active ? [active] : v.leases).flatMap((l) => [
      ...l.uris,
      ...l.forwarded
        .filter(
          (p) => p.host && p.externalPort > 0 && p.proto.toUpperCase() === "TCP"
        )
        .map((p) => `tcp://${p.host}:${p.externalPort}`),
    ]);
    return {
      externalName: dseq,
      state: v.state === "closed" ? "closed" : active ? "active" : "pending",
      endpoints: [...new Set(endpoints)],
      providerAccount: (active ?? v.leases[0])?.provider || undefined,
    };
  }

  // ---- PayerPort ----------------------------------------------------------------------------

  async create(req: PayerCreateRequest): Promise<PayerResource> {
    const known = this.keys[req.cogniKey];
    if (known) {
      const v = await this.view(known.dseq);
      if (v) return this.toResource(known.dseq, v);
    }
    const sdl = buildAkashSdl(req.spec as unknown as ProvisionSpec, {
      pricingDenom: this.cfg.pricingDenom ?? "uact",
      pricingAmount: this.cfg.pricingAmount ?? 1000,
      auditors: [OVERCLOCK_AUDITOR],
    });
    const created = await this.http<{
      dseq?: string | number;
      manifest?: unknown;
    }>("POST", "/v1/deployments", {
      data: { sdl, deposit: this.cfg.depositUsd ?? 0.5 },
    }).catch((e: unknown) => {
      throw new PayerError(
        "network",
        `console create failed: ${(e as Error).message}`,
        true
      );
    });
    if (!created?.dseq || created.manifest === undefined)
      throw new PayerError(
        "provider_rejected",
        "console create returned no dseq/manifest",
        true
      );
    const dseq = String(created.dseq);
    this.keys[req.cogniKey] = { dseq }; // persisted before any wait: a crash cannot leak it
    this.persist();
    this.cfg.log?.("console_created", { dseq });
    try {
      const needsHost = req.spec.services.some((s) =>
        s.expose?.some((e) => (e.hosts?.length ?? 0) > 0)
      );
      const exclude = new Set([
        ...(this.cfg.excludeProviders ?? []),
        ...(req.excludeProviders ?? []),
      ]);
      const bid = await this.awaitBid(dseq, needsHost, exclude);
      await this.http("POST", "/v1/leases", {
        manifest: created.manifest,
        leases: [
          {
            dseq: bid.dseq,
            gseq: bid.gseq,
            oseq: bid.oseq,
            provider: bid.provider,
          },
        ],
      });
      this.keys[req.cogniKey] = { dseq, provider: bid.provider };
      this.persist();
      this.cfg.log?.("console_leased", { dseq, provider: bid.provider });
    } catch (e) {
      const closed = await this.closeAndVerify(dseq);
      throw new PayerError(
        "provider_rejected",
        `console lease failed (${closed ? "closed" : "CLOSE UNVERIFIED"}): ${(e as Error).message}`.slice(
          0,
          300
        ),
        !closed
      );
    }
    const v = await this.view(dseq);
    return v
      ? this.toResource(dseq, v)
      : {
          externalName: dseq,
          state: "pending",
          endpoints: [],
          providerAccount: this.keys[req.cogniKey]?.provider,
        };
  }

  async observe(req: {
    cogniKey: string;
    externalName?: string;
  }): Promise<{ found: boolean; resource?: PayerResource }> {
    const dseq = req.externalName ?? this.keys[req.cogniKey]?.dseq;
    if (!dseq) return { found: false };
    const v = await this.view(dseq);
    return v
      ? { found: true, resource: this.toResource(dseq, v) }
      : { found: false };
  }

  async delete(req: { cogniKey: string; externalName: string }): Promise<void> {
    try {
      await this.http(
        "DELETE",
        `/v1/deployments/${encodeURIComponent(req.externalName)}`
      );
    } catch (e) {
      if (
        e instanceof ConsoleHttpError &&
        (e.status === 404 || e.status === 400)
      )
        return;
      throw new PayerError("provider_unavailable", (e as Error).message, false);
    }
  }

  /** DEV TEARDOWN helper: DELETE then poll until the readback says closed. */
  async closeAndVerify(dseq: string, timeoutMs = 90_000): Promise<boolean> {
    await this.delete({ cogniKey: "", externalName: dseq }).catch(
      () => undefined
    );
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await this.view(dseq).catch(() => undefined);
      if (v === null || v?.state === "closed") return true;
      await sleep(3000);
    }
    return false;
  }

  /** Account owner address seen on the deployments, for chain-truth reads in dev. */
  async ownerOf(dseq: string): Promise<string | undefined> {
    return (await this.view(dseq))?.owner;
  }

  // ---- bids ---------------------------------------------------------------------------------

  private async awaitBid(
    dseq: string,
    needsCustomDomain: boolean,
    exclude: ReadonlySet<string>
  ): Promise<Bid> {
    const providers =
      (await this.http<Json[]>("GET", "/v1/providers", undefined, 120_000)) ??
      [];
    const byOwner = new Map<string, ProviderInfo>(
      providers.map((p) => [
        String(p.owner),
        {
          owner: String(p.owner),
          isOnline: p.isOnline === true,
          isAudited: p.isAudited === true,
          customDomain:
            typeof p.featEndpointCustomDomain === "boolean"
              ? p.featEndpointCustomDomain
              : null,
        },
      ])
    );
    const denom = this.cfg.pricingDenom ?? "uact";
    const ceiling = this.cfg.pricingAmount ?? 1000;
    const passes = (b: Bid): boolean => {
      const p = byOwner.get(b.provider);
      if (!p?.isOnline || !p.isAudited || exclude.has(b.provider)) return false;
      if (needsCustomDomain && p.customDomain !== true) return false;
      return b.state === "open" && b.denom === denom && b.amount <= ceiling;
    };
    const deadline = Date.now() + (this.cfg.bidMs ?? 150_000);
    const grace = this.cfg.bidGraceMs ?? 10_000;
    let firstPassAt = 0;
    let last: Bid[] = [];
    while (Date.now() < deadline) {
      const raw =
        (await this.http<Json[]>(
          "GET",
          `/v1/bids?dseq=${encodeURIComponent(dseq)}`
        )) ?? [];
      const bids: Bid[] = [];
      for (const r of raw) {
        const b = (r.bid ?? r) as Json;
        const id = (b.id ?? {}) as Json;
        const price = (b.price ?? {}) as Json;
        if (!id.provider) continue;
        bids.push({
          dseq: String(id.dseq ?? dseq),
          gseq: Number(id.gseq ?? 1),
          oseq: Number(id.oseq ?? 1),
          provider: String(id.provider),
          state: String(b.state ?? "open"),
          denom: String(price.denom ?? ""),
          amount: Number(price.amount ?? Number.POSITIVE_INFINITY),
        });
      }
      last = bids.filter(passes);
      if (last.length > 0 && !firstPassAt) firstPassAt = Date.now();
      if (firstPassAt && Date.now() - firstPassAt >= grace) break;
      await sleep(3000);
    }
    if (last.length === 0) throw new Error(`no screened bid for dseq ${dseq}`);
    return last.reduce((a, b) => (b.amount < a.amount ? b : a));
  }
}
