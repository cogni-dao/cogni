// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/compute/lease-reactivation` (test)
 * Purpose: Pin `requiredLeaseGeneration` — the fresh/terminal/live/preparing matrix (task.5132).
 *   TERMINAL receipts (`released`/`failed`) force the next generation past themselves; a LIVE
 *   `allocated` receipt pins the derived generation AT its own (never past it); `preparing`
 *   proves nothing.
 * Side-effects: none
 * Links: src/features/compute/lease-reactivation.ts
 * @public
 */

import { describe, expect, it, vi } from "vitest";

import type { AkashTxAllocationRecord } from "@/ports";

import { requiredLeaseGeneration } from "./lease-reactivation";

const NODE_ID = "2f8b7a10-4c6e-4a7b-9d31-1c2e3f4a5b60";

function receipt(
  over: Partial<AkashTxAllocationRecord> & {
    state: AkashTxAllocationRecord["state"];
    generation: number;
    compositeGeneration?: number;
  }
): AkashTxAllocationRecord {
  const { generation, compositeGeneration = generation, ...rest } = over;
  return {
    receiptId: "r-1",
    cogniKey: `xcw:cogni-candidate-a-blue:blue:${generation}`,
    identity: {
      nodeId: NODE_ID,
      compositeUid: "8e5d4c3b-2a19-4f08-b7c6-5d4e3f2a1b09",
      compositeGeneration,
    },
    workload: "blue",
    environment: "candidate-a",
    ...rest,
  };
}

describe("requiredLeaseGeneration", () => {
  it("fresh: no receipts → the catalog's own generation (0 stays a birth row)", () => {
    expect(
      requiredLeaseGeneration({ catalogGeneration: 0, receipts: [] })
    ).toBe(0);
    expect(
      requiredLeaseGeneration({ catalogGeneration: 3, receipts: [] })
    ).toBe(3);
  });

  it("settled (released) receipt at the current generation → bump past it", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [receipt({ state: "released", generation: 0 })],
      })
    ).toBe(1);
  });

  it("derives from the immutable key suffix, never mutable Kubernetes metadata.generation", () => {
    // Live incident: one gen-35 lease reached composite metadata.generation 3729 after repeated
    // reconciles. Reading the latter generated an invalid 3730 catalog cell instead of 36.
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [
          receipt({
            state: "released",
            generation: 35,
            compositeGeneration: 3729,
          }),
        ],
      })
    ).toBe(36);
  });

  it("terminally FAILED gen-0 receipt → ADD derives generation 1 (task.5132)", () => {
    // The live incident: a failed gen-0 receipt existed, this derivation answered 0, and the
    // recreated XR presented `xcw:cogni-candidate-a:4b06359a-…:0` — refused by the actuator
    // with `akash_tx_identity_conflict` (ledgerState=failed, identity-bound to the dead
    // composite 02727e4b, observed 2026-09-18T03:01:34Z). `failed` is terminal from the ADD
    // path: bug.5192's failed-no-handle re-claim needs the SAME compositeUid, and a re-added
    // env recreates the composite with a new one.
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [receipt({ state: "failed", generation: 0 })],
      })
    ).toBe(1);
  });

  it("failed gen-0 AND failed gen-1 → 2 (max over terminal generations, plus one)", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [
          receipt({ state: "failed", generation: 0 }),
          receipt({ state: "failed", generation: 1 }),
        ],
      })
    ).toBe(2);
  });

  it("LIVE allocated gen-1 receipt → stays 1: pins its own generation, no spurious bump", () => {
    // A live paid lease must be re-stated, not leapfrogged — bumping past it would abandon a
    // billing lease and double-pay (LIVE_KEEPS_ITS_GENERATION).
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [receipt({ state: "allocated", generation: 1 })],
      })
    ).toBe(1);
  });

  it("terminal receipts bump past themselves; a higher live lease still pins the max", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [
          receipt({ state: "released", generation: 0 }),
          receipt({ state: "allocated", generation: 4 }),
          receipt({ state: "released", generation: 2 }),
        ],
      })
    ).toBe(4);
  });

  it("preparing receipts never move the answer — mid-transaction is not evidence", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 1,
        receipts: [receipt({ state: "preparing", generation: 1 })],
      })
    ).toBe(1);
  });

  it("receipts BELOW the catalog generation are already superseded — no bump", () => {
    expect(
      requiredLeaseGeneration({
        catalogGeneration: 5,
        receipts: [
          receipt({ state: "released", generation: 3 }),
          receipt({ state: "failed", generation: 2 }),
          receipt({ state: "allocated", generation: 4 }),
        ],
      })
    ).toBe(5);
  });

  it("refuses malformed receipt keys rather than guessing from mutable identity", () => {
    const malformed = receipt({ state: "released", generation: 35 });
    expect(() =>
      requiredLeaseGeneration({
        catalogGeneration: 0,
        receipts: [{ ...malformed, cogniKey: "legacy-key" }],
      })
    ).toThrow(/no valid lease generation suffix/);
  });
});

import type { AkashNativeObservation } from "@/types/akash-native-state";
// Existing-lane repair uses full identities and fresh native evidence, never the legacy suffix max.
import {
  evaluateTerminalLaneRepair,
  parseAppLeaseKey,
  qualifyTerminalLaneRepair,
} from "./lease-reactivation";

const repairSubject = {
  nodeId: NODE_ID,
  slug: "blue",
  environment: "candidate-a",
  namespace: "cogni-candidate-a",
  catalogGeneration: 20,
  accountId: "akash1owner",
};
const currentReceipt = (): AkashTxAllocationRecord => ({
  ...receipt({ state: "released", generation: 20 }),
  cogniKey: `xcw:cogni-candidate-a:${NODE_ID}:20`,
  externalName: "7001",
  providerAccount: "akash1supplier",
});
const closedNative = (): AkashNativeObservation => ({
  source: "https://api.akashnet.net",
  observedAt: "2026-10-31T22:00:00Z",
  deploymentState: "closed",
  deploymentCoverage: "complete",
  deploymentObservedAt: "2026-10-31T22:00:00Z",
  leaseCoverage: "complete",
  leasePages: [{ observedAt: "2026-10-31T22:00:00Z", count: 1 }],
  errorCode: null,
  leaseStates: [
    {
      id: {
        owner: "akash1owner",
        dseq: "7001",
        gseq: 1,
        oseq: 1,
        bseq: 0,
        provider: "akash1supplier",
      },
      state: "closed",
      observedAt: "2026-10-31T22:00:00Z",
    },
  ],
});
const evaluate = (
  rows = [currentReceipt()],
  native: Readonly<Record<string, AkashNativeObservation>> = {
    "7001": closedNative(),
  },
  complete = true
) =>
  evaluateTerminalLaneRepair({
    subject: repairSubject,
    receipts: rows,
    native,
    historyComplete: complete,
  });

describe("existing present:true terminal repair", () => {
  it("advances one base after exact terminal/native closure; Kubernetes generation is irrelevant", () => {
    expect(evaluate()).toMatchObject({
      kind: "repair",
      generation: 21,
      currentKey: currentReceipt().cogniKey,
      handle: "7001",
    });
  });
  it.each([
    "020",
    "1000001",
    "20:recover:0",
    "20:recover:4",
    "20:recover:01",
    "20:recover:1:extra",
    "20:other:1",
  ])("rejects malformed whole key %s", (suffix) => {
    expect(() =>
      parseAppLeaseKey(
        `xcw:cogni-candidate-a:${NODE_ID}:${suffix}`,
        repairSubject
      )
    ).toThrow();
  });
  it("recovery suffix is separate from base; a settled recovery does not jump to attempt+1", () => {
    const recoveries = [1, 2, 3].map((attempt) => ({
      ...currentReceipt(),
      receiptId: `r-recovery-${attempt}`,
      externalName: String(7001 + attempt),
      cogniKey: `${currentReceipt().cogniKey}:recover:${attempt}`,
    }));
    const native = Object.fromEntries(
      [7001, 7002, 7003, 7004].map((handle) => [
        String(handle),
        {
          ...closedNative(),
          leaseStates: closedNative().leaseStates.map((lease) => ({
            ...lease,
            id: { ...lease.id, dseq: String(handle) },
          })),
        },
      ])
    );
    expect(evaluate([currentReceipt(), ...recoveries], native)).toMatchObject({
      generation: 21,
    });
  });
  it.each([
    "allocated",
    "preparing",
  ] as const)("never advances current %s", (state) => {
    expect(() => evaluate([{ ...currentReceipt(), state }])).toThrow();
  });
  it("unused current floor is pending, never a second target", () => {
    expect(
      evaluateTerminalLaneRepair({
        subject: { ...repairSubject, catalogGeneration: 21 },
        receipts: [currentReceipt()],
        native: { "7001": closedNative() },
        historyComplete: true,
      })
    ).toEqual({ kind: "no_changes" });
  });
  it.each([
    { deploymentState: "active" },
    { deploymentState: null },
    { deploymentCoverage: "unknown" },
    { leaseCoverage: "partial" },
    { errorCode: "timeout" },
    { observedAt: null },
    {
      leaseStates: [{ ...closedNative().leaseStates[0], state: "reclaiming" }],
    },
    {
      leaseStates: [
        {
          ...closedNative().leaseStates[0],
          id: { ...closedNative().leaseStates[0]?.id, owner: "foreign" },
        },
      ],
    },
  ])("refuses unknown, live, incomplete or foreign native evidence %j", (change) => {
    expect(() =>
      evaluate([currentReceipt()], {
        "7001": { ...closedNative(), ...change } as AkashNativeObservation,
      })
    ).toThrow();
  });
  it("refuses incomplete history, missing native, retained data and handle-less current failures", () => {
    expect(() => evaluate(undefined, undefined, false)).toThrow();
    expect(() => evaluate(undefined, {})).toThrow();
    expect(() =>
      evaluate([{ ...currentReceipt(), retentionPolicy: "retain" }])
    ).toThrow();
    const { externalName: _handle, ...noHandle } = currentReceipt();
    expect(() => evaluate([{ ...noHandle, state: "failed" }])).toThrow();
  });
  it("refuses foreign family, node, composite, duplicate receipt and unresolved sibling", () => {
    for (const bad of [
      { ...currentReceipt(), cogniKey: `xcw:cogni-preview:${NODE_ID}:20` },
      {
        ...currentReceipt(),
        identity: { ...currentReceipt().identity, nodeId: "foreign" },
      },
      {
        ...currentReceipt(),
        identity: { ...currentReceipt().identity, compositeUid: "" },
      },
    ])
      expect(() => evaluate([bad])).toThrow();
    expect(() => evaluate([currentReceipt(), currentReceipt()])).toThrow();
    expect(() =>
      evaluate([
        currentReceipt(),
        {
          ...currentReceipt(),
          receiptId: "sibling",
          cogniKey: `xcw:cogni-candidate-a:${NODE_ID}:21`,
          state: "preparing",
        },
      ])
    ).toThrow();
  });
});

describe("terminal repair existing read capability", () => {
  const catalog = `name: blue\nnode_id: ${NODE_ID}\nsource_repo: https://github.com/cogni-dao/blue.git\nenvs: [candidate-a, production]\ndeployment_provider: {candidate-a: akash}\ncompute_api: {candidate-a: crossplane}\nlease_generation: {candidate-a: 20, production: 6}\n`;
  function setup() {
    const listReceipts = vi.fn(async () => [currentReceipt()]);
    const readNativeStates = vi.fn(async () => ({ "7001": closedNative() }));
    const input = {
      catalog,
      nodeId: NODE_ID,
      slug: "blue",
      environment: "candidate-a" as const,
      accountId: "akash1owner",
      hostingEnv: "production",
      fleetControlEnv: "production",
      leaseRead: { listReceipts, readNativeStates },
    };
    return { listReceipts, readNativeStates, input };
  }
  it("reads limit-plus-one history and exact handles at the existing native seam", async () => {
    const { input, listReceipts, readNativeStates } = setup();
    await expect(qualifyTerminalLaneRepair(input)).resolves.toMatchObject({
      generation: 21,
    });
    expect(listReceipts).toHaveBeenCalledWith({
      nodeId: NODE_ID,
      environment: "candidate-a",
      limit: 51,
    });
    expect(readNativeStates).toHaveBeenCalledWith({ dseqs: ["7001"] });
  });
  it("history truncation refuses before native reads", async () => {
    const { input, listReceipts, readNativeStates } = setup();
    listReceipts.mockResolvedValue(Array(51).fill(currentReceipt()));
    await expect(qualifyTerminalLaneRepair(input)).rejects.toMatchObject({
      code: "repair_history_incomplete",
    });
    expect(readNativeStates).not.toHaveBeenCalled();
  });
  it("owner/control/wallet and catalog identities cannot drift", async () => {
    for (const change of [
      { hostingEnv: "preview" },
      { accountId: undefined },
      { catalog: catalog.replace(NODE_ID, "foreign") },
      { catalog: catalog.replace("cogni-dao/blue", "unknown/blue") },
    ]) {
      const { input, listReceipts } = setup();
      await expect(
        qualifyTerminalLaneRepair({ ...input, ...change })
      ).rejects.toBeDefined();
      expect(listReceipts).not.toHaveBeenCalled();
    }
  });
  it("only explicitly declared canonical isolated-service families are excluded", async () => {
    const { input, listReceipts } = setup();
    const instance = {
      ...currentReceipt(),
      receiptId: "instance",
      cogniKey: `xcw:cogni-candidate-a:${NODE_ID}-db:3`,
    };
    listReceipts.mockResolvedValue([currentReceipt(), instance]);
    await expect(
      qualifyTerminalLaneRepair({
        ...input,
        catalog: `${catalog}isolated_services: {db: {}}\n`,
      })
    ).resolves.toMatchObject({ generation: 21 });
    await expect(qualifyTerminalLaneRepair(input)).rejects.toMatchObject({
      code: "repair_identity_conflict",
    });
  });
});
