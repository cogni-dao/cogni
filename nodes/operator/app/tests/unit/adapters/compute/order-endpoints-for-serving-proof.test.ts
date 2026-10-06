// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import { orderEndpointsForServingProof } from "@/adapters/server/compute/safe-version-probe";

/**
 * bug.5377 — the provider ingress must be proved BEFORE the workload's own public hostname.
 * Measured on spawny-boi 2026-10-06: candidate-a's lease listed the public host first and sat
 * at serving=false for hours while its public host served the exact expected sha; preview, on
 * the same node/provider/code, listed its ingress alias first and proved serving immediately.
 */
describe("orderEndpointsForServingProof", () => {
  const INGRESS = "te6eed3d49e1hasrh43rb8lq10.ingress.zencloud.eu";
  const PUBLIC = "spawny-boi.cogni-testing.org";

  it("moves the public host last so the provider ingress is proved first", () => {
    expect(orderEndpointsForServingProof([PUBLIC, INGRESS], PUBLIC)).toEqual([
      INGRESS,
      PUBLIC,
    ]);
  });

  it("leaves an already-correct order untouched (the preview shape)", () => {
    expect(orderEndpointsForServingProof([INGRESS, PUBLIC], PUBLIC)).toEqual([
      INGRESS,
      PUBLIC,
    ]);
  });

  it("still returns the public host when it is the ONLY endpoint", () => {
    expect(orderEndpointsForServingProof([PUBLIC], PUBLIC)).toEqual([PUBLIC]);
  });

  it("never drops or duplicates an endpoint", () => {
    const input = [PUBLIC, INGRESS, "other.example:8080"];
    const out = orderEndpointsForServingProof(input, PUBLIC);
    expect([...out].sort()).toEqual([...input].sort());
    expect(out).toHaveLength(input.length);
  });

  it("matches the public host through bare, port and absolute endpoint forms", () => {
    for (const form of [
      PUBLIC,
      `${PUBLIC}:80`,
      `http://${PUBLIC}/version`,
      `https://${PUBLIC}`,
      `${PUBLIC.toUpperCase()}`,
      `${PUBLIC}.`,
    ]) {
      expect(orderEndpointsForServingProof([form, INGRESS], PUBLIC)).toEqual([
        INGRESS,
        form,
      ]);
    }
  });

  it("is a no-op without a public host", () => {
    expect(orderEndpointsForServingProof([PUBLIC, INGRESS])).toEqual([
      PUBLIC,
      INGRESS,
    ]);
  });

  it("keeps an unparseable endpoint rather than silently discarding it", () => {
    const out = orderEndpointsForServingProof(["::::", INGRESS], PUBLIC);
    expect(out).toContain("::::");
    expect(out).toHaveLength(2);
  });
});
