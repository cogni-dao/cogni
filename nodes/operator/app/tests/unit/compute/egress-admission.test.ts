import { describe, expect, it } from "vitest";
import {
  mintReportCapability,
  verifyReportCapability,
} from "@/features/compute/egress-admission/hmac";
import { projectAdmission } from "@/features/compute/egress-admission/policy";
import { EgressReportCore } from "@/features/compute/egress-admission/report";

const identity = {
  receiptId: "6a278777-e8e1-4bf0-a0e2-f213bdfbb252",
  nodeId: "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d",
  lane: "candidate-a",
  compositeUid: "composite-1",
  keyVersion: "v1",
};
const keyring = { v1: Buffer.alloc(32, 7) };
const now = 1_800_000_000_000;
const observation = (ipv4: string, offset = 0) => ({
  ipv4,
  observedAt: now + offset,
  expiresAt: now + offset + 600_000,
  observerOrigin: "https://test.cognidao.org",
});
describe("receipt-derived admission", () => {
  it("rejects invalid MAC before any receipt IO", async () => {
    let calls = 0;
    const receipts = {
      report: async () => {
        calls++;
      },
      pin: async () => "v1",
      snapshot: async () => ({ complete: true, observations: [] }),
      stop: () => {},
    };
    const core = new EgressReportCore(keyring, receipts, () => now);
    const receiver = core.tryReceive();
    if (!receiver) throw new Error("missing_receiver");
    await expect(
      receiver.report({
        identity,
        token: "bad",
        observedIpv4: "8.8.8.8",
        observerOrigin: "https://test.cognidao.org",
      })
    ).rejects.toThrow("egress_unauthenticated");
    receiver.release();
    expect(core.size).toBe(0);
    expect(calls).toBe(0);
  });
  it("binds all immutable identity fields; verifier also holds mint authority", () => {
    const token = mintReportCapability(identity, keyring);
    expect(verifyReportCapability(identity, token, keyring)).toBe(true);
    for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
      expect(
        verifyReportCapability(
          { ...identity, [key]: `${identity[key]}x` },
          token,
          keyring
        )
      ).toBe(false);
    }
    expect(verifyReportCapability(identity, `${token}=`, keyring)).toBe(false);
    expect(verifyReportCapability(identity, token, {})).toBe(false);
  });
  it("rejects an invalid or over-capacity receipt snapshot", () => {
    const rows = ["8.8.8.1", "8.8.8.2", "8.8.8.3", "8.8.8.4", "8.8.8.5"].map(
      (ipv4) => ({ ...observation(ipv4), receiptId: identity.receiptId })
    );
    const destinations = () => [
      { destination: "lane", publishedPort: 5432 as const },
    ];
    expect(() =>
      projectAdmission(
        { complete: true, observations: rows },
        destinations,
        [],
        now
      )
    ).toThrow("observation_capacity");
    expect(() =>
      projectAdmission(
        {
          complete: true,
          observations: [
            {
              ...rows[0],
              ...observation("127.0.0.1"),
              receiptId: identity.receiptId,
            },
          ],
        },
        destinations,
        [],
        now
      )
    ).toThrow("invalid_grant");
  });
  it("uses absolute maximum expiry across owners and rejects incomplete/overflow snapshots", () => {
    const rows = [{ ...observation("8.8.8.8"), receiptId: identity.receiptId }];
    const destinations = () => [
      { destination: "lane", publishedPort: 5432 as const },
    ];
    const first = projectAdmission(
      { complete: true, observations: rows },
      destinations,
      [],
      now
    );
    expect(first[0]?.expiresAt).toBe(now + 600_000);
    expect(
      projectAdmission(
        { complete: true, observations: rows },
        destinations,
        [
          {
            destination: "lane",
            publishedPort: 5432,
            ipv4: "8.8.8.8",
            expiresAt: now + 650_000,
          },
        ],
        now
      )[0]?.expiresAt
    ).toBe(now + 650_000);
    expect(() =>
      projectAdmission(
        { complete: false, observations: [] },
        destinations,
        [],
        now
      )
    ).toThrow("incomplete_snapshot");
    expect(() =>
      projectAdmission(
        {
          complete: true,
          observations: Array.from({ length: 4097 }, () => ({
            ...observation("8.8.8.8"),
            receiptId: identity.receiptId,
          })),
        },
        destinations,
        [],
        now
      )
    ).toThrow("observation_overflow");
    expect(() =>
      projectAdmission(
        { complete: true, observations: rows },
        () => undefined,
        [],
        now
      )
    ).toThrow("unknown_dependency");
    expect(
      projectAdmission(
        { complete: true, observations: [] },
        destinations,
        [],
        now
      )
    ).toEqual([]);
    const overflow = Array.from({ length: 129 }, (_, i) => ({
      ...observation(`8.8.1.${i + 1}`),
      receiptId: `receipt-${i}`,
    }));
    expect(() =>
      projectAdmission(
        { complete: true, observations: overflow },
        destinations,
        [],
        now
      )
    ).toThrow("grant_overflow");
  });
});

it("bounds receiver/map cardinality and preserves unrelated same-NAT receipt progress", async () => {
  let time = now;
  let calls = 0;
  const core = new EgressReportCore(
    keyring,
    {
      report: async () => {
        calls++;
      },
      pin: async () => "v1",
      snapshot: async () => ({ complete: true, observations: [] }),
      stop: () => {},
    },
    () => time
  );
  const receivers = Array.from({ length: 8 }, () => core.tryReceive());
  expect(core.tryReceive()).toBeUndefined();
  for (const receiver of receivers) receiver?.release();
  expect(core.receiving).toBe(0);
  async function report(id: typeof identity, ipv4 = "8.8.8.8") {
    const receiver = core.tryReceive();
    if (!receiver) throw new Error("missing_receiver");
    try {
      await receiver.report({
        identity: id,
        token: mintReportCapability(id, keyring),
        observedIpv4: ipv4,
        observerOrigin: "https://test.cognidao.org",
      });
    } finally {
      receiver.release();
    }
  }
  await report(identity);
  await report(identity);
  expect(calls).toBe(1);
  await expect(report(identity, "8.8.8.9")).rejects.toThrow("rate_limited");
  for (let i = 1; i < 64; i++) {
    time += 16; // Finite normal authenticated load, below 64 HMAC/s.
    await report({
      ...identity,
      receiptId: `6a278777-e8e1-4bf0-a0e2-${i.toString(16).padStart(12, "0")}`,
    });
  }
  expect(core.size).toBe(64);
  expect(calls).toBe(64);
  time += 16;
  await expect(
    report({ ...identity, receiptId: "6a278777-e8e1-4bf0-a0e2-ffffffffffff" })
  ).rejects.toThrow("receipt_overload");
  expect(core.size).toBe(64);
  time += 121_000;
  await report(identity);
  expect(core.size).toBe(1);
  core.stop();
  expect(core.tryReceive()).toBeUndefined();
});
