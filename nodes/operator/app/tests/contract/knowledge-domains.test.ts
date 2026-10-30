// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import {
  DomainIdSchema,
  DomainsErrorResponseSchema,
  DomainsUpdateBodySchema,
  domainsDeleteOperation,
} from "@cogni/node-contracts";
/**
 * Module: `@tests/contract/knowledge-domains`
 * Purpose: Prove item domain transport preserves patch intent and typed refusals.
 * Scope: Pure contract checks; no storage, native execution or installed new-export proof.
 * Invariants: IDs immutable; explicit null clears description; empty patches rejected.
 * Side-effects: none
 * Links: packages/node-contracts/src/knowledge.domains.v1.contract.ts
 * @internal
 */
import { describe, expect, it } from "vitest";

describe("domain item wire contract", () => {
  it("distinguishes omitted fields from explicit description clearing", () => {
    expect(DomainsUpdateBodySchema.parse({ name: "New name" })).toEqual({
      name: "New name",
    });
    expect(DomainsUpdateBodySchema.parse({ description: null })).toEqual({
      description: null,
    });
  });
  it("rejects empty patches and ID mutation", () => {
    for (const body of [{}, null, { id: "renamed", name: "New name" }])
      expect(DomainsUpdateBodySchema.safeParse(body).success).toBe(false);
  });
  it("rejects malformed IDs", () => {
    for (const id of ["a", "UPPER", "../meta", "two words"])
      expect(DomainIdSchema.safeParse(id).success).toBe(false);
  });
  it("retains non-empty refusal count and unknown-write lookup receipt", () => {
    const refusal = {
      error: "entries remain",
      errorCode: "domain_not_empty",
      entryCount: 3,
    };
    expect(DomainsErrorResponseSchema.parse(refusal)).toEqual(refusal);
    const receipt = {
      error: "inspect receipt",
      errorCode: "knowledge_write_outcome_unknown",
      retryable: false,
      operationId: "domain.update:demo",
      branch: "main",
      commitHash: null,
    };
    expect(DomainsErrorResponseSchema.parse(receipt)).toEqual(receipt);
  });
  it("requires an affirmative delete receipt", () => {
    expect(
      domainsDeleteOperation.output.safeParse({ id: "demo", deleted: false })
        .success
    ).toBe(false);
  });
});
