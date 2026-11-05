// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@adapters/server/node-deploy/cloudflare-dns.adapter`
 * Purpose: Cloudflare zone DNS records for the blue/green edge: find by name, create, update, read
 *   (task.5400). Implements `DnsRecordsPort`.
 * Scope: HTTP only; the guard, adopt-by-name and readback policy live in `features/node-deploy/edge`.
 * Invariants:
 *   - NO_DELETE: this class has no delete method. The edge can never be withdrawn through it.
 *   - ONE_ZONE: the fleet binding names one zone; its projected native ID must agree before use.
 *   - IDENTITY_IS_NOT_EDIT: bounded parsed zone details prove identity/read access only.
 *   - ROTATION_REVALIDATES: cached identity is keyed by name, native ID and credential input.
 * Side-effects: IO (HTTPS to api.cloudflare.com)
 * @internal
 */

import { z } from "zod";
import {
  type DnsRecord,
  type DnsRecordInput,
  type DnsRecordsPort,
  DnsZoneIdentityError,
} from "@/ports";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";

export interface CloudflareDnsConfig {
  readonly binding: WorkloadZoneBinding;
  readonly apiToken: string;
  readonly zoneId: string;
  readonly fetchImpl?: typeof fetch;
  /** Re-read projected files so rotation invalidates the identity proof without a stale token cache. */
  readonly readCredentials?: () => Promise<{
    apiToken: string;
    zoneId: string;
  }>;
}

const zoneSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.string().regex(/^[a-f0-9]{32}$/i),
    name: z.string().min(1),
  }),
});

interface CfRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied?: boolean;
}

export class CloudflareDnsRecords implements DnsRecordsPort {
  private readonly fetchImpl: typeof fetch;
  private verified:
    | { apiToken: string; zoneId: string; zoneName: string }
    | undefined;
  constructor(private readonly cfg: CloudflareDnsConfig) {
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  private async credentials() {
    return this.cfg.readCredentials
      ? this.cfg.readCredentials()
      : { apiToken: this.cfg.apiToken, zoneId: this.cfg.zoneId };
  }

  async assertZoneIdentity(zoneName: string): Promise<void> {
    if (zoneName !== this.cfg.binding.zoneName)
      throw new DnsZoneIdentityError("zone_identity_mismatch");
    let credentials: { apiToken: string; zoneId: string };
    try {
      credentials = await this.credentials();
    } catch {
      throw new DnsZoneIdentityError("zone_identity_unavailable");
    }
    await this.verifyZone(credentials, zoneName);
  }

  private async verifyZone(
    credentials: { apiToken: string; zoneId: string },
    zoneName: string
  ): Promise<void> {
    if (!credentials.apiToken || !/^[a-f0-9]{32}$/i.test(credentials.zoneId))
      throw new DnsZoneIdentityError("zone_identity_unavailable");
    if (
      this.verified?.apiToken === credentials.apiToken &&
      this.verified.zoneId === credentials.zoneId &&
      this.verified.zoneName === zoneName
    )
      return;
    this.verified = undefined;
    try {
      const response = await this.fetchImpl(
        `https://api.cloudflare.com/client/v4/zones/${credentials.zoneId}`,
        {
          method: "GET",
          headers: { authorization: `Bearer ${credentials.apiToken}` },
          signal: AbortSignal.timeout(5_000),
        }
      );
      if (!response.ok)
        throw new DnsZoneIdentityError("zone_identity_unavailable");
      const parsed = zoneSchema.safeParse(await response.json());
      if (!parsed.success)
        throw new DnsZoneIdentityError("zone_identity_unavailable");
      if (
        parsed.data.result.id !== credentials.zoneId ||
        parsed.data.result.name.toLowerCase().replace(/\.$/, "") !== zoneName
      )
        throw new DnsZoneIdentityError("zone_identity_mismatch");
      this.verified = { ...credentials, zoneName };
    } catch (error) {
      if (error instanceof DnsZoneIdentityError) throw error;
      throw new DnsZoneIdentityError("zone_identity_unavailable");
    }
  }

  private async cf<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const credentials = await this.credentials();
    // Every record operation uses the SAME credential snapshot whose zone identity was checked.
    // Input changes invalidate cached proof. Never infer DNS edit permission from this read.
    const expected = this.verified?.zoneName;
    if (!expected) throw new DnsZoneIdentityError("zone_identity_unavailable");
    await this.verifyZone(credentials, expected);
    const res = await this.fetchImpl(
      `https://api.cloudflare.com/client/v4/zones/${credentials.zoneId}${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${credentials.apiToken}`,
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
