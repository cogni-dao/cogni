// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/mesh-dns`
 * Purpose: The DNS-only mesh host writer (task.5428): keeps each declared `mesh-<tailnet>` (coordinator) and
 *   `derp-<tailnet>` (relay) host in this sequencer's bound workload zone as a CNAME to the env VM alias that
 *   serves it, and reads it back. It exists for the test operator's own tailnet: its zone (cogni-testing.org)
 *   is writable only with the test operator's in-cluster zone token, which only this process holds.
 * Scope: Parse + guard + orchestration over `DnsRecordsPort`. Cloudflare HTTP lives in the adapter. Wiring and
 *   logging live in the sequencer bootstrap.
 * Invariants:
 *   - DECLARED_ONLY: the writer touches only the hosts named in its config (`NODE_DEPLOY_MESH_DNS_RECORDS`,
 *     pinned equal to the tailnet table in scripts/ci/lib/mesh-plane.sh by
 *     tests/ci-invariants/node-deploy-mesh-coordinators.spec.ts). The zone comes from the fleet binding.
 *   - MESH_LABELS_ONLY: a label must be `mesh-<name>` or `derp-<name>`; any other label is refused at parse, so
 *     this writer can never claim a node, operator or edge host.
 *   - DNS_ONLY: every record is written AND read back with `proxied=false`. Headscale (ts2021) and DERP do not
 *     work behind the Cloudflare proxy, and their hosts need publicly trusted ACME certificates at the VM.
 *   - TARGET_IS_THE_VM_ALIAS: the record is a CNAME to the env VM's alias host, so the address has one source
 *     (the alias record that provision writes) and no IP is copied.
 *   - NO_DELETE / ADOPT_BY_NAME / READBACK_IS_THE_TRUTH: same rules as the edge writer. One existing record is
 *     updated in place whatever its type; two records for one name are refused as ambiguous.
 * Side-effects: IO via the injected port
 * @internal
 */

import type { DnsRecord, DnsRecordsPort } from "@/ports";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";

/** One declared mesh record: `<label>.<zone>` CNAME `target`. */
export interface MeshDnsRecord {
  readonly label: string;
  readonly target: string;
}

export class MeshDnsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MeshDnsConfigError";
  }
}

export type MeshDnsOutcome = "ok" | "created" | "updated";

export interface MeshDnsResult {
  readonly host: string;
  readonly target: string;
  readonly outcome: MeshDnsOutcome;
}

const LABEL = /^(mesh|derp)-[a-z0-9]+(-[a-z0-9]+)*$/;
const HOSTNAME =
  /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const norm = (s: string): string => s.trim().toLowerCase().replace(/\.$/, "");

/**
 * Parse `label=target,label=target`. Empty or unset means no mesh record (production writes its canonical
 * mesh hosts through scripts/ci/reconcile-node-dns.sh, one writer per record).
 */
export function parseMeshDnsRecords(
  raw: string | undefined
): readonly MeshDnsRecord[] {
  const out: MeshDnsRecord[] = [];
  const seen = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const entry = part.trim();
    if (!entry) continue;
    const eq = entry.indexOf("=");
    const label = norm(eq < 0 ? entry : entry.slice(0, eq));
    const target = norm(eq < 0 ? "" : entry.slice(eq + 1));
    if (!LABEL.test(label))
      throw new MeshDnsConfigError(
        `mesh dns: "${label}" is not a mesh-<tailnet> or derp-<tailnet> label`
      );
    if (!HOSTNAME.test(target))
      throw new MeshDnsConfigError(
        `mesh dns: target for ${label} ("${target}") is not a hostname`
      );
    if (seen.has(label))
      throw new MeshDnsConfigError(`mesh dns: ${label} is declared twice`);
    seen.add(label);
    out.push({ label, target });
  }
  return out;
}

const matches = (r: DnsRecord, host: string, target: string): boolean =>
  norm(r.name) === host &&
  r.type === "CNAME" &&
  norm(r.content) === target &&
  r.proxied === false;

/**
 * Ensure every declared record exists as a DNS-only CNAME to its target. Throws on the first record that
 * cannot be written or read back; records already correct are left untouched (no write).
 */
export async function ensureMeshDnsRecords(
  dns: DnsRecordsPort,
  binding: WorkloadZoneBinding,
  records: readonly MeshDnsRecord[]
): Promise<readonly MeshDnsResult[]> {
  if (records.length === 0) return [];
  await dns.assertZoneIdentity(binding.zoneName);
  const results: MeshDnsResult[] = [];
  for (const { label, target } of records) {
    const host = `${label}.${norm(binding.zoneName)}`;
    if (target === host)
      throw new MeshDnsConfigError(
        `mesh dns: ${host} must not point at itself`
      );
    const found = await dns.findByName(host);
    if (found.length > 1)
      throw new Error(
        `mesh dns: ${found.length} records named ${host}; refusing to pick one`
      );
    const existing = found[0];
    if (existing && matches(existing, host, target)) {
      results.push({ host, target, outcome: "ok" });
      continue;
    }
    const payload = {
      type: "CNAME",
      name: host,
      content: target,
      proxied: false,
    } as const;
    const written = existing
      ? await dns.update(existing.id, payload)
      : await dns.create(payload);
    const back = await dns.read(written.id);
    if (!matches(back, host, target))
      throw new Error(
        `mesh dns readback mismatch for ${host}: ${JSON.stringify(back)}`
      );
    results.push({ host, target, outcome: existing ? "updated" : "created" });
  }
  return results;
}
