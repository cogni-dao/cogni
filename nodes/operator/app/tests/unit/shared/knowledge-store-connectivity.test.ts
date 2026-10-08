// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/shared/knowledge-store-connectivity`
 * Purpose: Prove the knowledge-plane readiness probe CONCLUDES unhealthy on a wedged store instead of hanging with it.
 * Scope: Pure stub port; no network, database, or environment IO.
 * Invariants: PROBE_IS_BOUNDED (a never-settling store yields InfraConnectivityError), NO_STORE_IS_NOT_A_FAILURE.
 * Side-effects: none
 * Links: src/shared/env/invariants.ts, src/app/(infra)/readyz/route.ts, bug.5386
 * @internal
 */

import { describe, expect, it, vi } from "vitest";

import {
  assertKnowledgeStoreConnectivity,
  InfraConnectivityError,
  KNOWLEDGE_STORE_PROBE_TIMEOUT_MS,
} from "@/shared/env/invariants";

describe("assertKnowledgeStoreConnectivity", () => {
  it("passes when the store answers", async () => {
    const domainExists = vi.fn(async () => false);

    await expect(
      assertKnowledgeStoreConnectivity({ domainExists })
    ).resolves.toBeUndefined();
    expect(domainExists).toHaveBeenCalledOnce();
  });

  it("treats a `true` answer as healthy too — it probes reachability, not content", async () => {
    await expect(
      assertKnowledgeStoreConnectivity({ domainExists: async () => true })
    ).resolves.toBeUndefined();
  });

  it("FAILS rather than hangs when the store never answers (bug.5386)", async () => {
    // A wedged postgres.js pool parks the query on an unbounded backlog: the
    // promise never resolves AND never rejects. This is the exact shape that
    // let candidate-a serve /readyz 200 with a dead knowledge plane.
    const neverSettles = () => new Promise<boolean>(() => undefined);

    await expect(
      assertKnowledgeStoreConnectivity(
        { domainExists: neverSettles },
        { timeoutMs: 50 }
      )
    ).rejects.toBeInstanceOf(InfraConnectivityError);
  });

  it("names the budget it exceeded so the blocking call is legible in logs", async () => {
    const neverSettles = () => new Promise<boolean>(() => undefined);

    await expect(
      assertKnowledgeStoreConnectivity(
        { domainExists: neverSettles },
        { timeoutMs: 50 }
      )
    ).rejects.toThrow(/did not answer within 50ms/);
  });

  it("surfaces an outright store error as InfraConnectivityError", async () => {
    await expect(
      assertKnowledgeStoreConnectivity({
        domainExists: async () => {
          throw new Error("ECONNREFUSED");
        },
      })
    ).rejects.toThrow(
      /Knowledge store connectivity check failed: ECONNREFUSED/
    );
  });

  it("is a silent no-op when the node has no knowledge store configured", async () => {
    // DOLTGRES_URL unset => the node claims no knowledge plane. Readiness must
    // not invent a failure for a capability that was never declared.
    await expect(
      assertKnowledgeStoreConnectivity(undefined)
    ).resolves.toBeUndefined();
  });

  it("keeps the default budget inside a k8s probe window", () => {
    expect(KNOWLEDGE_STORE_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(3000);
  });
});
