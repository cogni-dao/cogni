// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/domain/dns-helpers`
 * Purpose: Read-modify-write helpers for safe DNS record upsert and removal.
 * Scope: Orchestrates port calls. Uses TargetedDnsPort when available, falls back to full replacement. Does NOT import adapter implementations.
 * Invariants: Never calls setDnsRecords without reading first. Domain layer — no adapter imports.
 * Side-effects: none (delegates I/O to ports)
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @public
 */

import type { DomainRegistrarPort } from "../port/domain-registrar.port.js";
import type { TargetedDnsPort } from "../port/targeted-dns.port.js";
import type { DnsRecord } from "./types.js";

/**
 * Split "example.com" into { sld: "example", tld: "com" }.
 * Handles multi-part TLDs like "co.uk".
 */
export function splitDomain(domain: string): { sld: string; tld: string } {
  const parts = domain.split(".");
  if (parts.length < 2) {
    throw new Error(`Invalid domain: ${domain}`);
  }
  const [sld = ""] = parts;
  const tld = parts.slice(1).join(".");
  return { sld, tld };
}

/**
 * Protected record names that must never be modified or deleted.
 * These are production-critical records (root domain, www, mail).
 */
const PROTECTED_NAMES = new Set(["@", "www"]);

/** Throws if a record name is protected */
function assertNotProtected(name: string, domain: string): void {
  const normalized = name.toLowerCase();
  if (PROTECTED_NAMES.has(normalized) || normalized === domain.toLowerCase()) {
    throw new Error(
      `PROTECTED: refusing to modify record "${name}" on ${domain}. ` +
        `Root (@), www, and domain-name records are protected. ` +
        `Remove this guard only if you know what you are doing.`
    );
  }
}

/** Type guard: does this registrar support targeted record operations? */
function isTargetedDns(
  r: DomainRegistrarPort
): r is DomainRegistrarPort & TargetedDnsPort {
  return "findRecords" in r && "createRecord" in r && "deleteRecord" in r;
}

/**
 * Add or replace a DNS record by (name, type) match.
 * Uses targeted Cloudflare API if available, otherwise read-modify-write.
 */
export async function upsertDnsRecord(
  registrar: DomainRegistrarPort,
  domain: string,
  record: DnsRecord
): Promise<DnsRecord> {
  assertNotProtected(record.name, domain);
  if (isTargetedDns(registrar)) {
    // Cloudflare: find existing by FQDN, update or create
    const fqdn = record.name === "@" ? domain : `${record.name}.${domain}`;
    const existing = await registrar.findRecords(fqdn, record.type);
    if (existing.length > 0 && existing[0]?.id) {
      return registrar.updateRecord(existing[0]?.id, record, domain);
    }
    return registrar.createRecord(record, domain);
  }

  // Generic: read-modify-write (Namecheap, etc.)
  const { sld, tld } = splitDomain(domain);
  const all = await registrar.getDnsRecords(sld, tld);
  const idx = all.findIndex(
    (r) => r.name === record.name && r.type === record.type
  );
  const updated = [...all];
  if (idx >= 0) {
    updated[idx] = record;
  } else {
    updated.push(record);
  }
  await registrar.setDnsRecords(sld, tld, updated);
  return record;
}

/**
 * Remove a DNS record by (name, type) match.
 * Uses targeted Cloudflare API if available, otherwise read-modify-write.
 * No-op if the record doesn't exist.
 */
export async function removeDnsRecord(
  registrar: DomainRegistrarPort,
  domain: string,
  name: string,
  type: DnsRecord["type"]
): Promise<void> {
  assertNotProtected(name, domain);
  if (isTargetedDns(registrar)) {
    const fqdn = name === "@" ? domain : `${name}.${domain}`;
    const existing = await registrar.findRecords(fqdn, type);
    await Promise.all(
      existing
        .filter((r): r is DnsRecord & { id: string } => r.id != null)
        .map((r) => registrar.deleteRecord(r.id))
    );
    return;
  }

  // Generic: read-modify-write
  const { sld, tld } = splitDomain(domain);
  const all = await registrar.getDnsRecords(sld, tld);
  const filtered = all.filter((r) => !(r.name === name && r.type === type));
  if (filtered.length !== all.length) {
    await registrar.setDnsRecords(sld, tld, filtered);
  }
}
