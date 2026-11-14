// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/port/domain-registrar`
 * Purpose: Base port interface for domain registration and DNS management.
 * Scope: Interface definition only. Does NOT contain implementation.
 * Invariants: setDnsRecords is full replacement — callers must read-modify-write.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @public
 */

import type {
  DnsRecord,
  DomainAvailability,
  RegistrantContact,
  RegistrationResult,
} from "../domain/types.js";

/**
 * Domain registrar port — interface for domain registration and DNS management.
 *
 * Two use cases:
 * 1. DAO setup: check + register + initial DNS
 * 2. Preview deploys: upsert/remove DNS records under an existing domain
 */
export interface DomainRegistrarPort {
  /** Check availability for one or more domains */
  checkAvailability(domains: string[]): Promise<DomainAvailability[]>;

  /** Register a new domain with WHOIS contact info */
  registerDomain(
    domain: string,
    contact: RegistrantContact,
    years?: number
  ): Promise<RegistrationResult>;

  /** Get all DNS host records for a domain */
  getDnsRecords(sld: string, tld: string): Promise<DnsRecord[]>;

  /**
   * Replace ALL DNS host records for a domain.
   * CAUTION: This is a full replacement — always read-modify-write.
   */
  setDnsRecords(sld: string, tld: string, records: DnsRecord[]): Promise<void>;
}
