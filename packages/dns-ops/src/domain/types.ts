// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/domain/types`
 * Purpose: Domain types for DNS operations — records, credentials, registration.
 * Scope: Pure type definitions. Does NOT contain logic or I/O.
 * Invariants: Types must be serialization-safe (no Date objects, no functions).
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @public
 */

/** DNS record types supported by common registrars/DNS providers */
export type DnsRecordType =
  | "A"
  | "AAAA"
  | "CNAME"
  | "MX"
  | "TXT"
  | "NS"
  | "SRV"
  | "CAA";

export interface DnsRecord {
  /** Hostname (e.g., "pr-123.preview", "@", "www") */
  name: string;
  type: DnsRecordType;
  /** Record value (IP address, hostname, etc.) */
  value: string;
  /** TTL in seconds. Default: 1 (auto) for Cloudflare, 1800 for Namecheap */
  ttl?: number;
  /** MX priority. Only used for MX records. */
  mxPref?: number;
  /** Whether traffic is proxied through Cloudflare. Default: false (DNS only) */
  proxied?: boolean;
  /** Provider-specific record ID (for updates/deletes) */
  id?: string;
}

export interface DomainAvailability {
  domain: string;
  available: boolean;
  /** Price in USD if available */
  price?: number;
}

export interface RegistrantContact {
  firstName: string;
  lastName: string;
  address1: string;
  city: string;
  stateProvince: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  organization?: string;
  address2?: string;
}

export interface RegistrationResult {
  domain: string;
  success: boolean;
  domainId?: number;
  orderId?: number;
  transactionId?: number;
  chargedAmount?: number;
  errorMessage?: string;
}

/** Namecheap credentials — passed at construction time */
export interface NamecheapCredentials {
  apiUser: string;
  apiKey: string;
  clientIp: string;
  sandbox?: boolean;
}

/** Cloudflare credentials — passed at construction time */
export interface CloudflareCredentials {
  /** API token (scoped, recommended) or global API key */
  apiToken: string;
  /** Cloudflare Zone ID for the domain (found on domain overview page) */
  zoneId: string;
}
