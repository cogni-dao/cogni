// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/adapters/cloudflare`
 * Purpose: Cloudflare DNS API adapter — implements DomainRegistrarPort and TargetedDnsPort.
 * Scope: HTTP calls to Cloudflare API v4. Does not support domain registration.
 * Invariants: PURE_LIBRARY — credentials via constructor, no process.env access.
 * Side-effects: IO (HTTP to api.cloudflare.com)
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @public
 */

import type { CloudflareCredentials, DnsRecord } from "../domain/types.js";
import type { DomainRegistrarPort } from "../port/domain-registrar.port.js";

const CF_API = "https://api.cloudflare.com/client/v4";

interface CfApiResponse {
  success: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: Cloudflare API returns varied shapes
  result: any;
  result_info?: { page: number; per_page: number; total_pages: number };
  errors?: Array<{ code: number; message: string }>;
}

interface CfDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied: boolean;
  priority?: number;
}

/**
 * Cloudflare DNS adapter. Implements only the DNS subset of DomainRegistrarPort.
 * Domain registration is not supported — use NamecheapAdapter for that.
 */
export class CloudflareAdapter implements DomainRegistrarPort {
  private readonly token: string;
  private readonly zoneId: string;

  constructor(creds: CloudflareCredentials) {
    this.token = creds.apiToken;
    this.zoneId = creds.zoneId;
  }

  async checkAvailability(): Promise<never> {
    throw new Error(
      "CloudflareAdapter does not support domain registration. Use NamecheapAdapter."
    );
  }

  async registerDomain(): Promise<never> {
    throw new Error(
      "CloudflareAdapter does not support domain registration. Use NamecheapAdapter."
    );
  }

  async getDnsRecords(_sld: string, _tld: string): Promise<DnsRecord[]> {
    // Cloudflare uses zone ID, not SLD/TLD — params kept for interface compat
    const records: DnsRecord[] = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const res = await this.cfFetch(
        `/zones/${this.zoneId}/dns_records?per_page=${perPage}&page=${page}`
      );
      for (const r of res.result as CfDnsRecord[]) {
        records.push(cfToDnsRecord(r));
      }
      if (page >= (res.result_info?.total_pages ?? 1)) break;
      page++;
    }

    return records;
  }

  async setDnsRecords(
    _sld: string,
    _tld: string,
    records: DnsRecord[]
  ): Promise<void> {
    // Full replacement: delete all, then create all.
    // WARNING: Not atomic — if creation fails after deletion, records are lost.
    // Prefer createRecord/updateRecord/deleteRecord for targeted changes.
    const existing = await this.getDnsRecords(_sld, _tld);

    await Promise.all(
      existing
        .filter((r) => r.id)
        .map((r) =>
          this.cfFetch(`/zones/${this.zoneId}/dns_records/${r.id}`, {
            method: "DELETE",
          })
        )
    );

    await Promise.all(
      records.map((r) =>
        this.cfFetch(`/zones/${this.zoneId}/dns_records`, {
          method: "POST",
          body: JSON.stringify(dnsRecordToCf(r)),
        })
      )
    );
  }

  // ── Cloudflare-native methods (preferred for DNS) ─────────

  /** Create a single DNS record without touching others */
  async createRecord(record: DnsRecord, _domain: string): Promise<DnsRecord> {
    const res = await this.cfFetch(`/zones/${this.zoneId}/dns_records`, {
      method: "POST",
      body: JSON.stringify(dnsRecordToCf(record)),
    });
    return cfToDnsRecord(res.result as CfDnsRecord);
  }

  /** Update a single DNS record by ID */
  async updateRecord(
    recordId: string,
    record: DnsRecord,
    _domain: string
  ): Promise<DnsRecord> {
    const res = await this.cfFetch(
      `/zones/${this.zoneId}/dns_records/${recordId}`,
      {
        method: "PUT",
        body: JSON.stringify(dnsRecordToCf(record)),
      }
    );
    return cfToDnsRecord(res.result as CfDnsRecord);
  }

  /** Delete a single DNS record by ID */
  async deleteRecord(recordId: string): Promise<void> {
    await this.cfFetch(`/zones/${this.zoneId}/dns_records/${recordId}`, {
      method: "DELETE",
    });
  }

  /** Find records matching name and/or type */
  async findRecords(
    name?: string,
    type?: DnsRecord["type"]
  ): Promise<DnsRecord[]> {
    const params = new URLSearchParams();
    if (name) params.set("name", name);
    if (type) params.set("type", type);
    params.set("per_page", "100");

    const res = await this.cfFetch(
      `/zones/${this.zoneId}/dns_records?${params.toString()}`
    );
    return (res.result as CfDnsRecord[]).map(cfToDnsRecord);
  }

  // ── internal ──────────────────────────────────────────────

  private async cfFetch(
    path: string,
    init?: RequestInit
  ): Promise<CfApiResponse> {
    const res = await fetch(`${CF_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });

    const json = (await res.json()) as CfApiResponse;

    if (!json.success) {
      const errors =
        json.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ??
        "Unknown error";
      throw new Error(`Cloudflare API error: ${errors}`);
    }

    return json;
  }
}

// ── Converters ──────────────────────────────────────────────

function cfToDnsRecord(cf: CfDnsRecord): DnsRecord {
  return {
    id: cf.id,
    name: cf.name,
    type: cf.type as DnsRecord["type"],
    value: cf.content,
    ttl: cf.ttl,
    proxied: cf.proxied,
    mxPref: cf.priority,
  };
}

function dnsRecordToCf(r: DnsRecord): Record<string, unknown> {
  const cf: Record<string, unknown> = {
    type: r.type,
    name: r.name,
    content: r.value,
    ttl: r.ttl ?? 1, // 1 = "auto" in Cloudflare
    proxied: r.proxied ?? false,
  };
  if (r.type === "MX" && r.mxPref != null) {
    cf.priority = r.mxPref;
  }
  return cf;
}
