// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/cloudflare-dns.adapter`
 * Purpose: Cloudflare zone DNS records for the blue/green edge: find by name, create, update, read
 *   (task.5400). Implements `DnsRecordsPort`.
 * Scope: HTTP only; the guard, adopt-by-name and readback policy live in `features/node-deploy/edge`.
 * Invariants:
 *   - NO_DELETE: this class has no delete method. The edge can never be withdrawn through it.
 *   - ONE_ZONE: constructed for exactly one zone id.
 * Side-effects: IO (HTTPS to api.cloudflare.com)
 * @internal
 */

import type { DnsRecord, DnsRecordInput, DnsRecordsPort } from "@/ports";

export interface CloudflareDnsConfig {
  readonly apiToken: string;
  readonly zoneId: string;
  readonly fetchImpl?: typeof fetch;
}

interface CfRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

export class CloudflareDnsRecords implements DnsRecordsPort {
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly cfg: CloudflareDnsConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async cf<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const res = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/zones/${this.cfg.zoneId}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${this.cfg.apiToken}`,
          "content-type": "application/json",
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(30_000),
      }
    );
    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      result?: T;
      errors?: unknown;
    };
    if (!res.ok || json.success === false)
      throw new Error(
        `cloudflare ${method} ${path.split("?")[0]} -> ${res.status} ${JSON.stringify(json.errors ?? "").slice(0, 300)}`
      );
    return json.result as T;
  }

  private static map(r: CfRecord): DnsRecord {
    return {
      id: r.id,
      name: r.name,
      type: r.type,
      content: r.content,
      proxied: r.proxied === true,
    };
  }

  async findByName(name: string): Promise<readonly DnsRecord[]> {
    const rows = await this.cf<CfRecord[]>(
      "GET",
      `/dns_records?name=${encodeURIComponent(name)}`
    );
    return rows.map(CloudflareDnsRecords.map);
  }

  async create(input: DnsRecordInput): Promise<DnsRecord> {
    return CloudflareDnsRecords.map(
      await this.cf<CfRecord>("POST", "/dns_records", { ...input, ttl: 1 })
    );
  }

  async update(id: string, input: DnsRecordInput): Promise<DnsRecord> {
    return CloudflareDnsRecords.map(
      await this.cf<CfRecord>("PUT", `/dns_records/${id}`, { ...input, ttl: 1 })
    );
  }

  async read(id: string): Promise<DnsRecord> {
    return CloudflareDnsRecords.map(
      await this.cf<CfRecord>("GET", `/dns_records/${id}`)
    );
  }
}
