// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/mesh-dns.test`
 * Purpose: The DNS-only mesh host writer (task.5428): parse guards, create/adopt/no-op, DNS-only readback.
 * Scope: Pure logic over an in-memory `DnsRecordsPort`. No network.
 * Invariants: MESH_LABELS_ONLY, DNS_ONLY, ADOPT_BY_NAME, READBACK_IS_THE_TRUTH (see mesh-dns.ts).
 * Side-effects: none
 * @internal
 */

import { describe, expect, it } from "vitest";

import { DnsZoneIdentityError } from "@/ports";
import type { WorkloadZoneBinding } from "@/shared/node-registry/fleet-ownership";

import {
  ensureMeshDnsRecords,
  MeshDnsConfigError,
  parseMeshDnsRecords,
} from "./mesh-dns";
import { FakeDns } from "./testing";

const binding: WorkloadZoneBinding = {
  fleetOwner: "cogni-test-org",
  zoneName: "cogni-testing.org",
  zoneIdRef: "CLOUDFLARE_ZONE_ID",
  writerRef: "operator-env-secrets/CLOUDFLARE_API_TOKEN",
};
const VM = "cogni-candidate-a.vm.cognidao.org";
const RAW = `mesh-test-candidate-a=${VM},derp-test-candidate-a=${VM}`;

function dns(): FakeDns {
  const d = new FakeDns([]);
  d.zoneName = "cogni-testing.org";
  return d;
}

describe("parseMeshDnsRecords", () => {
  it("parses label=target pairs; unset or empty declares nothing", () => {
    expect(parseMeshDnsRecords(RAW)).toEqual([
      { label: "mesh-test-candidate-a", target: VM },
      { label: "derp-test-candidate-a", target: VM },
    ]);
    expect(parseMeshDnsRecords(undefined)).toEqual([]);
    expect(parseMeshDnsRecords(" ")).toEqual([]);
  });

  it.each([
    [`poly-test=${VM}`, "not a mesh"],
    [`node-deploy-canary-test=${VM}`, "not a mesh"],
    ["mesh-x", "not a hostname"],
    ["mesh-x=http://x", "not a hostname"],
    [`mesh-x=${VM},mesh-x=${VM}`, "declared twice"],
  ])("refuses %s", (raw, message) => {
    expect(() => parseMeshDnsRecords(raw)).toThrow(MeshDnsConfigError);
    expect(() => parseMeshDnsRecords(raw)).toThrow(message);
  });
});

describe("ensureMeshDnsRecords", () => {
  it("creates DNS-only CNAMEs in the bound zone, then writes nothing on the next pass", async () => {
    const d = dns();
    const first = await ensureMeshDnsRecords(
      d,
      binding,
      parseMeshDnsRecords(RAW)
    );
    expect(first).toEqual([
      {
        host: "mesh-test-candidate-a.cogni-testing.org",
        target: VM,
        outcome: "created",
      },
      {
        host: "derp-test-candidate-a.cogni-testing.org",
        target: VM,
        outcome: "created",
      },
    ]);
    for (const r of d.records.values()) {
      expect(r).toMatchObject({ type: "CNAME", content: VM, proxied: false });
    }
    const second = await ensureMeshDnsRecords(
      d,
      binding,
      parseMeshDnsRecords(RAW)
    );
    expect(second.map((r) => r.outcome)).toEqual(["ok", "ok"]);
    expect(d.ops).toHaveLength(2);
  });

  it("adopts an existing record by name whatever its type, and turns the proxy off", async () => {
    const d = dns();
    d.seed({
      name: "mesh-test-candidate-a.cogni-testing.org",
      type: "A",
      content: "84.32.9.111",
      proxied: true,
    });
    const out = await ensureMeshDnsRecords(
      d,
      binding,
      parseMeshDnsRecords(RAW)
    );
    expect(out[0]?.outcome).toBe("updated");
    expect(d.records.size).toBe(2);
    expect([...d.records.values()][0]).toMatchObject({
      type: "CNAME",
      content: VM,
      proxied: false,
    });
  });

  it("refuses two records for one name", async () => {
    const d = dns();
    for (const content of ["a.example.org", "b.example.org"])
      d.seed({
        name: "mesh-test-candidate-a.cogni-testing.org",
        type: "CNAME",
        content,
        proxied: false,
      });
    await expect(
      ensureMeshDnsRecords(d, binding, parseMeshDnsRecords(RAW))
    ).rejects.toThrow("refusing to pick one");
    expect(d.ops).toEqual([]);
  });

  it("fails when the readback is not DNS-only", async () => {
    const d = dns();
    const read = d.read.bind(d);
    d.read = async (id) => ({ ...(await read(id)), proxied: true });
    await expect(
      ensureMeshDnsRecords(d, binding, parseMeshDnsRecords(RAW))
    ).rejects.toThrow("readback mismatch");
  });

  it("writes nothing when the zone identity check fails", async () => {
    const d = dns();
    d.zoneUnavailable = true;
    await expect(
      ensureMeshDnsRecords(d, binding, parseMeshDnsRecords(RAW))
    ).rejects.toBeInstanceOf(DnsZoneIdentityError);
    expect(d.ops).toEqual([]);
  });

  it("does no Cloudflare call when nothing is declared", async () => {
    const d = dns();
    expect(await ensureMeshDnsRecords(d, binding, [])).toEqual([]);
    expect(d.identityReads).toBe(0);
  });
});
