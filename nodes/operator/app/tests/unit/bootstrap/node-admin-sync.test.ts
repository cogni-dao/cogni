// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/node-admin-sync`
 * Purpose: Verify the node-admin sync orchestration and its approver reader adapter.
 * Scope: Fake authorization port plus injected reader functions; no database, GitHub, OpenFGA, or timers.
 * Invariants: REPORT_ONLY_WRITES_NOTHING, NEVER_LOCK_OUT, NEVER_THROWS, ONE_EVENT_PER_NODE_PER_TICK,
 *   USER_IDS_ONLY_IN_LOGS, BOUNDED_CONCURRENCY, READ_DEADLINE, TEST_INERT.
 * Side-effects: none
 * Links: src/bootstrap/jobs/nodeAdminSync.ts, src/adapters/server/identity/repo-spec-node-approver-reader.adapter.ts, task.5494
 * @internal
 */

import { FakeAuthorizationAdapter } from "@cogni/authorization-core";
import { describe, expect, it, vi } from "vitest";

import {
  extractRepoSpecApprovers,
  RepoSpecNodeApproverReader,
} from "@/adapters/server/identity/repo-spec-node-approver-reader.adapter";
import {
  type NodeAdminSyncDeps,
  syncNodeAdmin,
  syncNodeAdmins,
} from "@/bootstrap/jobs/nodeAdminSync";
import {
  runNodeAdminSyncTick,
  startNodeAdminSyncOnBoot,
} from "@/bootstrap/node-admin-sync";
import type { NodeApproverRead, NodeApproverTarget } from "@/ports";

const NODE: NodeApproverTarget = {
  nodeId: "11111111-1111-4111-8111-111111111111",
  repoUrl: "https://github.com/cogni-dao/toks5",
  repoSpecPath: ".cogni/repo-spec.yaml",
};
const OBJECT = `node:${NODE.nodeId}`;

function makeLog() {
  return { info: vi.fn(), warn: vi.fn() };
}

async function seedAdmins(
  authorization: FakeAuthorizationAdapter,
  userIds: string[]
) {
  for (const id of userIds) {
    await authorization.writeRelation({
      user: `user:${id}`,
      relation: "admin",
      object: OBJECT,
    });
  }
}

function deps(
  read: NodeApproverRead,
  authorization: FakeAuthorizationAdapter,
  write: boolean
): NodeAdminSyncDeps & { log: ReturnType<typeof makeLog> } {
  return {
    reader: { approvers: async () => read },
    authorization,
    write,
    log: makeLog(),
  };
}

const tick = vi.hoisted(() => ({
  summary: {
    nodes: 0,
    byOutcome: {} as Record<string, number>,
    mode: "report" as "report" | "write",
    skipped: false,
  },
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/bootstrap/jobs/syncNodeAdmins.job", () => ({
  runNodeAdminSyncJob: vi.fn(async () => tick.summary),
}));
vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ log: tick.log }),
}));

describe("syncNodeAdmin", () => {
  it("report mode logs the diff and writes nothing", async () => {
    const authorization = new FakeAuthorizationAdapter();
    await seedAdmins(authorization, ["old"]);
    const write = vi.spyOn(authorization, "writeRelation");
    const del = vi.spyOn(authorization, "deleteRelation");
    const d = deps(
      { status: "read", approverCount: 1, userIds: ["new"] },
      authorization,
      false
    );

    const result = await syncNodeAdmin(d, NODE);

    expect(result).toEqual({
      nodeId: NODE.nodeId,
      outcome: "ok",
      mode: "report",
      adds: 1,
      deletes: 1,
    });
    expect(write).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
    expect(d.log.info).toHaveBeenCalledTimes(1);
    expect(d.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "identity.node_admin_sync",
        nodeId: NODE.nodeId,
        outcome: "ok",
        mode: "report",
        adds: 1,
        deletes: 1,
        addUserIds: ["new"],
        deleteUserIds: ["old"],
      }),
      "identity.node_admin_sync"
    );
  });

  it("write mode applies the diff", async () => {
    const authorization = new FakeAuthorizationAdapter();
    await seedAdmins(authorization, ["old"]);
    const d = deps(
      { status: "read", approverCount: 1, userIds: ["new"] },
      authorization,
      true
    );

    const result = await syncNodeAdmin(d, NODE);

    expect(result).toMatchObject({ outcome: "ok", mode: "write" });
    expect(
      authorization.hasRelation({
        user: "user:new",
        relation: "admin",
        object: OBJECT,
      })
    ).toBe(true);
    expect(
      authorization.hasRelation({
        user: "user:old",
        relation: "admin",
        object: OBJECT,
      })
    ).toBe(false);
  });

  it("leaves non-admin relations and other nodes alone", async () => {
    const authorization = new FakeAuthorizationAdapter();
    await seedAdmins(authorization, ["old"]);
    const developer = {
      user: "user:agent",
      relation: "developer",
      object: OBJECT,
    };
    await authorization.writeRelation(developer);
    await syncNodeAdmin(
      deps(
        { status: "read", approverCount: 1, userIds: ["new"] },
        authorization,
        true
      ),
      NODE
    );
    expect(authorization.hasRelation(developer)).toBe(true);
  });

  it.each([
    [
      "unavailable",
      "timeout",
      { status: "unavailable", reason: "timeout" } as NodeApproverRead,
    ],
    [
      "empty",
      "no_approvers",
      { status: "read", approverCount: 0, userIds: [] },
    ],
    [
      "empty",
      "unmapped_approvers",
      { status: "read", approverCount: 2, userIds: [] },
    ],
  ] as const)("%s/%s: write mode deletes and adds nothing and names its reason", async (outcome, reason, read) => {
    const authorization = new FakeAuthorizationAdapter();
    await seedAdmins(authorization, ["old"]);
    const write = vi.spyOn(authorization, "writeRelation");
    const del = vi.spyOn(authorization, "deleteRelation");

    const result = await syncNodeAdmin(deps(read, authorization, true), NODE);

    expect(result.outcome).toBe(outcome);
    expect(result.reason).toBe(reason);
    expect(write).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("an unreadable current-tuple list is unavailable and writes nothing", async () => {
    const authorization = new FakeAuthorizationAdapter();
    authorization.failNextList();
    const write = vi.spyOn(authorization, "writeRelation");

    const result = await syncNodeAdmin(
      deps(
        { status: "read", approverCount: 1, userIds: ["new"] },
        authorization,
        true
      ),
      NODE
    );

    expect(result.outcome).toBe("unavailable");
    expect(result.reason).toBe("openfga_read_failed");
    expect(write).not.toHaveBeenCalled();
  });

  it("a failed add skips every delete so the admin set never shrinks", async () => {
    const authorization = new FakeAuthorizationAdapter();
    await seedAdmins(authorization, ["old"]);
    vi.spyOn(authorization, "writeRelation").mockResolvedValue({
      decision: "failure",
      code: "authz_write_unavailable",
    });
    const del = vi.spyOn(authorization, "deleteRelation");
    const d = deps(
      { status: "read", approverCount: 1, userIds: ["new"] },
      authorization,
      true
    );

    const result = await syncNodeAdmin(d, NODE);

    expect(result.outcome).toBe("unavailable");
    expect(del).not.toHaveBeenCalled();
    expect(d.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "unavailable",
        reason: "openfga_write_failed",
        writeFailed: true,
      }),
      "identity.node_admin_sync"
    );
  });

  it("never throws: a throwing reader is this node's unavailable", async () => {
    const authorization = new FakeAuthorizationAdapter();
    const d: NodeAdminSyncDeps = {
      reader: {
        approvers: async () => {
          throw new Error("boom");
        },
      },
      authorization,
      write: true,
      log: makeLog(),
    };
    await expect(syncNodeAdmin(d, NODE)).resolves.toMatchObject({
      outcome: "unavailable",
      reason: "unexpected",
    });
  });
});

describe("syncNodeAdmins", () => {
  it("bounds concurrency and returns one result per node, in order", async () => {
    let inFlight = 0;
    let peak = 0;
    const nodes = Array.from({ length: 8 }, (_, i) => ({
      ...NODE,
      nodeId: `00000000-0000-4000-8000-00000000000${i}`,
    }));
    const d: NodeAdminSyncDeps = {
      reader: {
        approvers: async () => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight -= 1;
          return { status: "unavailable", reason: "timeout" };
        },
      },
      authorization: new FakeAuthorizationAdapter(),
      write: false,
      log: makeLog(),
    };

    const results = await syncNodeAdmins(d, nodes);

    expect(peak).toBe(3);
    expect(results.map((r) => r.nodeId)).toEqual(nodes.map((n) => n.nodeId));
  });
});

describe("RepoSpecNodeApproverReader", () => {
  const spec = "approvers-yaml";
  const base = {
    extractApprovers: () => [
      "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa",
      "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb",
    ],
    usersForWallets: async (wallets: readonly string[]) =>
      wallets.includes("0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
        ? ["user-a"]
        : [],
  };

  it("passes the repo URL and the path separately, lowercases wallets, and maps users", async () => {
    const fetchRepoSpec = vi.fn(async () => spec);
    const usersForWallets = vi.fn(base.usersForWallets);
    const reader = new RepoSpecNodeApproverReader({
      ...base,
      fetchRepoSpec,
      usersForWallets,
    });

    await expect(reader.approvers(NODE)).resolves.toEqual({
      status: "read",
      approverCount: 2,
      userIds: ["user-a"],
    });
    expect(fetchRepoSpec).toHaveBeenCalledWith(
      "https://github.com/cogni-dao/toks5",
      ".cogni/repo-spec.yaml"
    );
    expect(usersForWallets).toHaveBeenCalledWith([
      "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    ]);
  });

  it("a failed or missing read is unavailable", async () => {
    const failing = new RepoSpecNodeApproverReader({
      ...base,
      fetchRepoSpec: async () => {
        throw new Error("App not installed");
      },
    });
    const missing = new RepoSpecNodeApproverReader({
      ...base,
      fetchRepoSpec: async () => null,
    });
    const notInstalled = new RepoSpecNodeApproverReader({
      ...base,
      fetchRepoSpec: async () => {
        throw Object.assign(new Error("not installed"), {
          code: "github_app_not_installed",
        });
      },
    });
    await expect(failing.approvers(NODE)).resolves.toEqual({
      status: "unavailable",
      reason: "unexpected",
    });
    await expect(notInstalled.approvers(NODE)).resolves.toEqual({
      status: "unavailable",
      reason: "no_app_installation",
    });
    await expect(missing.approvers(NODE)).resolves.toEqual({
      status: "unavailable",
      reason: "not_found",
    });
  });

  it("a read that exceeds the deadline is unavailable", async () => {
    const reader = new RepoSpecNodeApproverReader({
      ...base,
      readTimeoutMs: 10,
      fetchRepoSpec: () => new Promise(() => {}),
    });
    await expect(reader.approvers(NODE)).resolves.toEqual({
      status: "unavailable",
      reason: "timeout",
    });
  });

  it("an unreadable approvers value reads as malformed, not as an empty list", async () => {
    const reader = new RepoSpecNodeApproverReader({
      ...base,
      fetchRepoSpec: async () => spec,
      extractApprovers: () => {
        throw new Error("invalid approvers");
      },
    });
    await expect(reader.approvers(NODE)).resolves.toEqual({
      status: "read",
      approverCount: 0,
      userIds: [],
      malformed: true,
    });
  });

  it("a failed user lookup is unavailable, never an empty list", async () => {
    const reader = new RepoSpecNodeApproverReader({
      ...base,
      fetchRepoSpec: async () => spec,
      usersForWallets: async () => {
        throw new Error("db down");
      },
    });
    await expect(reader.approvers(NODE)).resolves.toEqual({
      status: "unavailable",
      reason: "user_lookup_failed",
    });
  });
});

describe("startNodeAdminSyncOnBoot", () => {
  it("is inert in tests: it starts no timer", () => {
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    startNodeAdminSyncOnBoot();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

describe("runNodeAdminSyncTick", () => {
  it("logs one tick event with a count per outcome, even for a tick with zero rows", async () => {
    tick.log.info.mockClear();
    tick.summary = { nodes: 0, byOutcome: {}, mode: "report", skipped: false };
    await runNodeAdminSyncTick();
    expect(tick.log.info).toHaveBeenCalledTimes(1);
    expect(tick.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "identity.node_admin_sync.tick",
        mode: "report",
        nodes: 0,
        skipped: false,
        ok: 0,
        unavailable: 0,
        empty: 0,
        refused: 0,
      }),
      "identity.node_admin_sync.tick"
    );
  });

  it("reports counts per outcome", async () => {
    tick.log.info.mockClear();
    tick.summary = {
      nodes: 4,
      byOutcome: { ok: 2, unavailable: 1, empty: 1 },
      mode: "write",
      skipped: false,
    };
    await runNodeAdminSyncTick();
    expect(tick.log.info).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "write",
        nodes: 4,
        ok: 2,
        unavailable: 1,
        empty: 1,
        refused: 0,
      }),
      "identity.node_admin_sync.tick"
    );
  });
});

// The real shape of a fork repo-spec that still carries a retired field (spawny-boi, candidate-a).
const SPEC_WITH_RETIRED_FIELD = `
schema_version: "0.1.4"
node_id: "11111111-1111-4111-8111-111111111111"
deployment:
  services:
    - name: app
      secret_refs:
        - key: EXTRA_KEY
activity_ledger:
  epoch_length_days: 7
  approvers:
    - "0xAbCdEf0123456789aBcDeF0123456789AbCdEf01"
`;

describe("extractRepoSpecApprovers (APPROVERS_ONLY)", () => {
  it("still yields the approver when an unrelated retired field would fail the strict parser", () => {
    expect(extractRepoSpecApprovers(SPEC_WITH_RETIRED_FIELD)).toEqual([
      "0xabcdef0123456789abcdef0123456789abcdef01",
    ]);
  });

  it("an empty list is valid and empty", () => {
    expect(
      extractRepoSpecApprovers("activity_ledger:\n  approvers: []\n")
    ).toEqual([]);
    expect(extractRepoSpecApprovers("node_id: x\n")).toEqual([]);
  });

  it.each([
    ["YAML that does not parse", "activity_ledger: [unclosed"],
    ["a spec that is not a mapping", "- just\n- a list\n"],
    ["approvers that is not a list", "activity_ledger:\n  approvers: nope\n"],
    [
      "an entry that is not an address",
      'activity_ledger:\n  approvers:\n    - "0x123"\n',
    ],
  ])("throws for %s", (_name, text) => {
    expect(() => extractRepoSpecApprovers(text)).toThrow();
  });

  it("the package-backed reader still reads the approver of a spec with a retired field (spawny-boi)", async () => {
    const fetchRepoSpec = vi.fn(async () => SPEC_WITH_RETIRED_FIELD);
    const usersForWallets = vi.fn(async () => ["user-a"]);
    const reader = new RepoSpecNodeApproverReader({
      fetchRepoSpec,
      extractApprovers: extractRepoSpecApprovers,
      usersForWallets,
    });

    await expect(reader.approvers(NODE)).resolves.toEqual({
      status: "read",
      approverCount: 1,
      userIds: ["user-a"],
    });
    expect(fetchRepoSpec).toHaveBeenCalledWith(
      "https://github.com/cogni-dao/toks5",
      ".cogni/repo-spec.yaml"
    );
    expect(usersForWallets).toHaveBeenCalledWith([
      "0xabcdef0123456789abcdef0123456789abcdef01",
    ]);
  });

  it("maps to the right reason end to end: malformed_spec vs no_approvers, both write nothing", async () => {
    const run = async (text: string) => {
      const authorization = new FakeAuthorizationAdapter();
      await seedAdmins(authorization, ["old"]);
      const write = vi.spyOn(authorization, "writeRelation");
      const del = vi.spyOn(authorization, "deleteRelation");
      const result = await syncNodeAdmin(
        {
          reader: new RepoSpecNodeApproverReader({
            fetchRepoSpec: async () => text,
            extractApprovers: extractRepoSpecApprovers,
            usersForWallets: async () => ["user-a"],
          }),
          authorization,
          write: true,
          log: makeLog(),
        },
        NODE
      );
      expect(write).not.toHaveBeenCalled();
      expect(del).not.toHaveBeenCalled();
      return result;
    };

    await expect(run("activity_ledger: [unclosed")).resolves.toMatchObject({
      outcome: "empty",
      reason: "malformed_spec",
    });
    await expect(
      run("activity_ledger:\n  approvers: []\n")
    ).resolves.toMatchObject({ outcome: "empty", reason: "no_approvers" });
  });
});
