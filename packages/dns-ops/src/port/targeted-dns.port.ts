// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/dns-ops/port/targeted-dns`
 * Purpose: Extended DNS port for providers supporting targeted record operations.
 * Scope: Interface definition only. Cloudflare implements this; Namecheap does not.
 * Invariants: Implementations must handle concurrent access safely.
 * Side-effects: none
 * Links: https://cognidao.org/knowledge/node-dns-operations
 * @public
 */

import type { DnsRecord } from "../domain/types.js";

/**
 * Extended DNS port for providers that support targeted record operations
 * (create/update/delete individual records) without full replacement.
 *
 * Cloudflare implements this; Namecheap does not.
 */
export interface TargetedDnsPort {
  createRecord(record: DnsRecord, domain: string): Promise<DnsRecord>;
  updateRecord(
    recordId: string,
    record: DnsRecord,
    domain: string
  ): Promise<DnsRecord>;
  deleteRecord(recordId: string): Promise<void>;
  findRecords(name?: string, type?: DnsRecord["type"]): Promise<DnsRecord[]>;
}
