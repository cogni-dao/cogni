// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/adapters/namecheap`
 * Purpose: Namecheap XML API adapter — implements DomainRegistrarPort for registration and DNS.
 * Scope: HTTP calls to Namecheap API. XML parsing via fast-xml-parser. Does NOT access process.env.
 * Invariants: PURE_LIBRARY — credentials via constructor, no process.env access.
 * Side-effects: IO (HTTP to api.namecheap.com)
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @public
 */

import { XMLParser } from "fast-xml-parser";
import type {
  DnsRecord,
  DomainAvailability,
  NamecheapCredentials,
  RegistrantContact,
  RegistrationResult,
} from "../domain/types.js";
import type { DomainRegistrarPort } from "../port/domain-registrar.port.js";

const PRODUCTION_URL = "https://api.namecheap.com/xml.response";
const SANDBOX_URL = "https://api.sandbox.namecheap.com/xml.response";

// fast-xml-parser does not support external entity resolution (no XXE risk).
// processEntities:false is set explicitly to document the security posture.
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
});

export class NamecheapAdapter implements DomainRegistrarPort {
  private readonly baseUrl: string;
  private readonly creds: NamecheapCredentials;

  constructor(creds: NamecheapCredentials) {
    this.creds = creds;
    this.baseUrl = creds.sandbox ? SANDBOX_URL : PRODUCTION_URL;
  }

  async checkAvailability(domains: string[]): Promise<DomainAvailability[]> {
    const xml = await this.call("namecheap.domains.check", {
      DomainList: domains.join(","),
    });
    const result = xml.ApiResponse.CommandResponse.DomainCheckResult;
    const results = Array.isArray(result) ? result : [result];
    return results.map((r: Record<string, string>) => ({
      domain: String(r["@_Domain"] ?? ""),
      available: r["@_Available"] === "true",
    }));
  }

  async registerDomain(
    domain: string,
    contact: RegistrantContact,
    years = 1
  ): Promise<RegistrationResult> {
    const contactParams = buildContactParams(contact);
    const xml = await this.call("namecheap.domains.create", {
      DomainName: domain,
      Years: String(years),
      // Use Namecheap's default nameservers
      Nameservers: "",
      AddFreeWhoisguard: "yes",
      WGEnabled: "yes",
      ...contactParams,
    });

    const dr = xml.ApiResponse.CommandResponse.DomainCreateResult;
    return {
      domain: dr["@_Domain"] ?? domain,
      success: dr["@_Registered"] === "true",
      domainId: dr["@_DomainID"] ? Number(dr["@_DomainID"]) : undefined,
      orderId: dr["@_OrderID"] ? Number(dr["@_OrderID"]) : undefined,
      transactionId: dr["@_TransactionID"]
        ? Number(dr["@_TransactionID"])
        : undefined,
      chargedAmount: dr["@_ChargedAmount"]
        ? Number(dr["@_ChargedAmount"])
        : undefined,
    };
  }

  async getDnsRecords(sld: string, tld: string): Promise<DnsRecord[]> {
    const xml = await this.call("namecheap.domains.dns.getHosts", {
      SLD: sld,
      TLD: tld,
    });
    const hosts = xml.ApiResponse.CommandResponse.DomainDNSGetHostsResult?.host;
    if (!hosts) return [];
    const hostList = Array.isArray(hosts) ? hosts : [hosts];
    return hostList.map((h: Record<string, string>) => ({
      name: String(h["@_Name"] ?? ""),
      type: String(h["@_Type"] ?? "A") as DnsRecord["type"],
      value: String(h["@_Address"] ?? ""),
      ttl: h["@_TTL"] ? Number(h["@_TTL"]) : undefined,
      mxPref: h["@_MXPref"] ? Number(h["@_MXPref"]) : undefined,
    }));
  }

  async setDnsRecords(
    sld: string,
    tld: string,
    records: DnsRecord[]
  ): Promise<void> {
    const params: Record<string, string> = { SLD: sld, TLD: tld };
    for (let i = 0; i < records.length; i++) {
      const r = records[i];
      if (!r) continue;
      const n = i + 1;
      params[`HostName${n}`] = r.name;
      params[`RecordType${n}`] = r.type;
      params[`Address${n}`] = r.value;
      params[`TTL${n}`] = String(r.ttl ?? 1800);
      if (r.type === "MX" && r.mxPref != null) {
        params[`MXPref${n}`] = String(r.mxPref);
      }
    }
    const xml = await this.call("namecheap.domains.dns.setHosts", params);
    const result = xml.ApiResponse.CommandResponse.DomainDNSSetHostsResult;
    if (result?.["@_IsSuccess"] !== "true") {
      throw new Error(`Failed to set DNS records: ${JSON.stringify(result)}`);
    }
  }

  // ── internal ──────────────────────────────────────────────

  private async call(
    command: string,
    params: Record<string, string>
    // biome-ignore lint/suspicious/noExplicitAny: XML parser returns untyped nested objects
  ): Promise<Record<string, any>> {
    const url = new URL(this.baseUrl);
    url.searchParams.set("ApiUser", this.creds.apiUser);
    url.searchParams.set("ApiKey", this.creds.apiKey);
    url.searchParams.set("UserName", this.creds.apiUser);
    url.searchParams.set("ClientIp", this.creds.clientIp);
    url.searchParams.set("Command", command);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url.toString(), { method: "GET" });
    if (!res.ok) {
      throw new Error(`Namecheap API HTTP ${res.status}: ${await res.text()}`);
    }

    const text = await res.text();
    const parsed = xmlParser.parse(text);

    if (parsed.ApiResponse?.["@_Status"] === "ERROR") {
      const errors = parsed.ApiResponse.Errors?.Error;
      const msg = Array.isArray(errors)
        ? errors.map((e: Record<string, unknown>) => e["#text"] ?? e).join("; ")
        : (errors?.["#text"] ?? errors ?? "Unknown error");
      throw new Error(`Namecheap API error: ${msg}`);
    }

    return parsed;
  }
}

/** Build Namecheap contact params for all 4 contact types (Registrant, Tech, Admin, AuxBilling) */
function buildContactParams(c: RegistrantContact): Record<string, string> {
  const params: Record<string, string> = {};
  const prefixes = ["Registrant", "Tech", "Admin", "AuxBilling"];
  for (const prefix of prefixes) {
    params[`${prefix}FirstName`] = c.firstName;
    params[`${prefix}LastName`] = c.lastName;
    params[`${prefix}Address1`] = c.address1;
    if (c.address2) params[`${prefix}Address2`] = c.address2;
    params[`${prefix}City`] = c.city;
    params[`${prefix}StateProvince`] = c.stateProvince;
    params[`${prefix}PostalCode`] = c.postalCode;
    params[`${prefix}Country`] = c.country;
    params[`${prefix}Phone`] = c.phone;
    params[`${prefix}EmailAddress`] = c.email;
    if (c.organization) params[`${prefix}OrganizationName`] = c.organization;
  }
  return params;
}
