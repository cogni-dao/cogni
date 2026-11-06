// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/node-deploy-lanes`
 * Purpose: Restart the actual lane composition over existing paid records with invalid DNS config.
 * Scope: Real composition and sequencer, in-memory port implementations; no native durability claim.
 * Invariants: Recovery remains reachable; unavailable authority cannot create fresh HTTP or DNS effects.
 * Side-effects: none
 */

import { describe, expect, it, vi } from "vitest";
import { composeNodeDeployLanes } from "@/bootstrap/node-deploy-lanes";
import { EnvLaneSequencers } from "@/features/node-deploy/env-lanes";
import { DEFAULT_SEQUENCER_CONFIG } from "@/features/node-deploy/sequencer";
import {
  canaryApp,
  canaryDb,
  ENV,
  FakeChain,
  FakeClock,
  FakeDns,
  FakePayer,
  FakeProbe,
  MemoryLog,
  MemorySecrets,
  MemoryStore,
  NODE_ID,
  SHA_1,
} from "@/features/node-deploy/testing";
import type { AttemptPhase } from "@/ports";

describe("actual sequencer lane composition without new DNS authority", () => {
  it.each([
    { fleetOwner: "cogni-dao", zoneName: undefined },
    { fleetOwner: "cogni-dao", zoneName: "https://invalid/zone" },
    { fleetOwner: undefined, zoneName: "cognidao.org" },
  ])("preserves existing paid recovery with $fleetOwner / $zoneName", async (config) => {
    const clock = new FakeClock();
    const events: string[] = [];
    const store = new MemoryStore(clock);
    const payer = new FakePayer(events);
    const observe = vi.spyOn(payer, "observe");
    const dns = new FakeDns(events);
    const probe = new FakeProbe(payer, dns, events);
    const secrets = new MemorySecrets();
    const log = new MemoryLog();
    const seed = async (name: string, phase: AttemptPhase, state = false) => {
      const spec = state
        ? canaryDb({ name })
        : canaryApp({ name, bindings: [] });
      const { release } = await store.recordRelease({
        nodeId: NODE_ID,
        env: ENV,
        workload: name,
        sourceSha: SHA_1,
        spec,
        createdBy: "before-restart",
      });
      const attempt = await store.insertAttempt(
        release.id,
        (n) => `old:${name}:${n}`
      );
      const dseq = `old-${name}`;
      const endpoints = state
        ? [`tcp://provider.example:31000`]
        : [`${name}.ingress.example`];
      payer.leases.push({
        dseq,
        cogniKey: attempt.cogniKey,
        provider: "provider",
        state: "active",
        endpoints,
        env: { RELEASE_SHA: SHA_1 },
      });
      const saved = await store.updateAttempt(attempt.id, {
        phase,
        ...(phase === "planned"
          ? { error: "ambiguous: lost paid response" }
          : { externalName: dseq, endpoints, provider: "provider" }),
      });
      return { release, attempt: saved, dseq };
    };
    const ambiguous = await seed("ambiguous", "planned");
    const closing = await seed("closing", "closing");
    const active = await seed("active", "active");
    const state = await seed("state", "active", true);
    const fresh = await store.recordRelease({
      nodeId: NODE_ID,
      env: ENV,
      workload: "fresh",
      sourceSha: SHA_1,
      spec: canaryApp({ name: "fresh", bindings: [] }),
      createdBy: "before-restart",
    });
    const originalIds = store.attempts.map((a) => [
      a.id,
      a.cogniKey,
      a.releaseId,
    ]);
    const dnsRecordsFor = vi.fn(async () => dns);
    const nodeDeploySlugs = vi.fn(async () => ["operator"]);
    const composed = await composeNodeDeployLanes({
      ...config,
      lanes: [
        {
          environment: ENV,
          secretsNamespace: `cogni-node-deploy-${ENV}`,
          substrateHost: "substrate.example",
        },
      ],
      dnsRecordsFor,
      nodeDeploySlugs,
      depsForLane: () => ({
        store,
        payer,
        probe,
        secrets,
        clock,
        log,
        chain: new FakeChain(payer),
        config: {
          ...DEFAULT_SEQUENCER_CONFIG,
          environment: ENV,
          namespace: "cogni-production",
        },
      }),
    });
    expect(composed.authority).toEqual({
      ok: false,
      reason: "workload_zone_not_configured",
    });
    const lanes = new EnvLaneSequencers(
      composed.lanes,
      (_env, _loop, error) => {
        throw error;
      }
    );
    await lanes.tick();
    await lanes.reconcileAll();
    const saved = (id: string) => store.attempts.find((a) => a.id === id);
    expect(saved(ambiguous.attempt.id)?.externalName).toBe(ambiguous.dseq);
    // The adopted paid effect is proven and then HELD at cutover (dependency/waiting): an invalid
    // binding neither moves the edge nor closes a proven green; a valid restart can still activate it.
    expect(saved(ambiguous.attempt.id)?.phase).toBe("proven");
    expect(payer.byDseq(ambiguous.dseq).state).toBe("active");
    expect(
      log.lines.some(
        (l) =>
          l.fields.workload === "ambiguous" &&
          l.fields.step === "dependency" &&
          l.fields.outcome === "waiting" &&
          l.fields.reason === "workload_zone_not_configured"
      )
    ).toBe(true);
    expect(events.some((e) => e === `payer.delete:${ambiguous.dseq}`)).toBe(
      false
    );
    expect(saved(closing.attempt.id)?.phase).toBe("failed");
    expect(payer.byDseq(closing.dseq).state).toBe("closed");
    expect(saved(active.attempt.id)?.phase).toBe("active");
    expect(saved(state.attempt.id)?.phase).toBe("active");
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        cogniKey: active.attempt.cogniKey,
        externalName: active.dseq,
      })
    );
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        cogniKey: state.attempt.cogniKey,
        externalName: state.dseq,
      })
    );
    // A fresh app waits before any attempt row or payment exists (NO_HALF_ENV), naming the reason.
    expect(
      store.attempts.filter((a) => a.releaseId === fresh.release.id)
    ).toEqual([]);
    expect(
      log.lines.some(
        (l) =>
          l.fields.workload === "fresh" &&
          l.fields.step === "dependency" &&
          l.fields.outcome === "waiting" &&
          String(l.fields.reason ?? l.fields.why ?? "").includes(
            "workload_zone_not_configured"
          )
      )
    ).toBe(true);
    // A retained state loss still reaches its owner and must never trigger replacement.
    payer.byDseq(state.dseq).state = "closed";
    await lanes.reconcileAll();
    await lanes.tick();
    expect(saved(state.attempt.id)?.phase).toBe("lost");
    expect(
      store.attempts.filter((a) => a.releaseId === state.release.id)
    ).toHaveLength(1);
    expect(
      store.attempts
        .slice(0, originalIds.length)
        .map((a) => [a.id, a.cogniKey, a.releaseId])
    ).toEqual(originalIds);
    expect(payer.createRequests).toHaveLength(0);
    expect(dnsRecordsFor).not.toHaveBeenCalled();
    expect(nodeDeploySlugs).not.toHaveBeenCalled();
    expect(dns.records.size).toBe(0);
  });
});
