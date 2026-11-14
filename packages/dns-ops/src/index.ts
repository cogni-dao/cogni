// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops`
 * Purpose: Public barrel export for dns-ops package.
 * Scope: Exports ports, domain types, adapters, and helpers. Does NOT contain runtime logic.
 * Invariants: NO_SRC_IMPORTS, NO_SERVICE_IMPORTS, PURE_LIBRARY.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @public
 */

// Ports

// Adapters
export { CloudflareAdapter } from "./adapters/cloudflare.adapter.js";
export { NamecheapAdapter } from "./adapters/namecheap.adapter.js";
// Helpers
export {
  removeDnsRecord,
  splitDomain,
  upsertDnsRecord,
} from "./domain/dns-helpers.js";
// Domain types
export type {
  CloudflareCredentials,
  DnsRecord,
  DnsRecordType,
  DomainAvailability,
  NamecheapCredentials,
  RegistrantContact,
  RegistrationResult,
} from "./domain/types.js";
export type { DomainRegistrarPort } from "./port/domain-registrar.port.js";
export type { TargetedDnsPort } from "./port/targeted-dns.port.js";
