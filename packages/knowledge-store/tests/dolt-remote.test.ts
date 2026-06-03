// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/knowledge-store/tests/dolt-remote`
 * Purpose: Unit coverage for the Doltgres push factory — lazy remote registration, SQL shape, error swallowing for re-adds.
 * Scope: Pure tests with a recording fake Sql. Does not exercise a real Doltgres or network. The reserved-connection path is not used by this adapter (push doesn't need branch isolation), so no postgres.js reserve() fake is needed.
 * Invariants: First push registers the remote; subsequent pushes skip the add. "already exists" during add is swallowed; other add errors propagate.
 * Side-effects: none
 * Links: docs/runbooks/dolthub-remote-bootstrap.md, packages/knowledge-store/src/adapters/doltgres/dolt-remote.ts
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  createDoltgresPuller,
  createDoltgresPusher,
  type DoltgresPusher,
  wrapPushSafe,
} from "../src/adapters/doltgres/dolt-remote.js";

type FakeSql = {
  unsafe: (query: string) => Promise<unknown>;
  calls: string[];
};

function fakeSql(opts?: {
  failAddWith?: string;
  failPushWith?: string;
}): FakeSql {
  const calls: string[] = [];
  return {
    calls,
    unsafe: async (query: string) => {
      calls.push(query);
      if (opts?.failAddWith && query.includes("dolt_remote")) {
        throw new Error(opts.failAddWith);
      }
      if (opts?.failPushWith && query.includes("dolt_push")) {
        throw new Error(opts.failPushWith);
      }
      return [{}];
    },
  };
}

describe("createDoltgresPusher", () => {
  it("lazy-registers the remote on first pushBranch, then only pushes thereafter", async () => {
    const sql = fakeSql();
    const pusher = createDoltgresPusher({
      // biome-ignore lint/suspicious/noExplicitAny: test fake satisfies the narrow surface used by the adapter
      sql: sql as any,
      remoteName: "origin",
      remoteUrl:
        "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator",
    });

    await pusher.pushBranch();
    expect(sql.calls).toHaveLength(2);
    expect(sql.calls[0]).toContain("dolt_remote");
    expect(sql.calls[0]).toContain("add");
    expect(sql.calls[0]).toContain("origin");
    expect(sql.calls[0]).toContain(
      "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator"
    );
    expect(sql.calls[1]).toContain("dolt_push");
    expect(sql.calls[1]).toContain("'origin'");
    expect(sql.calls[1]).toContain("'main'");

    await pusher.pushBranch();
    // Only one new call — the push. The lazy ensureRemote() skips on second go.
    expect(sql.calls).toHaveLength(3);
    expect(sql.calls[2]).toContain("dolt_push");
  });

  it("swallows 'already exists' during remote add (idempotent across restarts)", async () => {
    const sql = fakeSql({ failAddWith: "remote already exists" });
    const pusher = createDoltgresPusher({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
    });

    // Should not throw — even though the add errored, ensureRemote treats it as success.
    await expect(pusher.pushBranch()).resolves.toBeUndefined();
    expect(sql.calls).toHaveLength(2);
  });

  it("propagates non-'already exists' errors during remote add", async () => {
    const sql = fakeSql({ failAddWith: "network unreachable" });
    const pusher = createDoltgresPusher({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
    });

    await expect(pusher.pushBranch()).rejects.toThrow(/network unreachable/);
    // The push call is never issued because ensureRemote threw.
    expect(sql.calls).toHaveLength(1);
  });

  it("propagates errors from dolt_push (caller's responsibility to handle)", async () => {
    const sql = fakeSql({ failPushWith: "permission denied" });
    const pusher = createDoltgresPusher({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
    });

    await expect(pusher.pushBranch()).rejects.toThrow(/permission denied/);
    // Add succeeded, push failed — remoteReady stays true so the next call skips add.
    await expect(pusher.pushBranch()).rejects.toThrow(/permission denied/);
    expect(sql.calls.filter((c) => c.includes("dolt_remote"))).toHaveLength(1);
  });

  it("respects the custom branch param when provided", async () => {
    const sql = fakeSql();
    const pusher = createDoltgresPusher({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
      branch: "release",
    });

    await pusher.pushBranch();
    expect(sql.calls[1]).toContain("'release'");
    expect(sql.calls[1]).not.toContain("'main'");
  });
});

type FakePullSql = {
  reserve: () => Promise<{
    unsafe: (query: string) => Promise<unknown>;
    release: () => void;
  }>;
  calls: string[];
  released: number;
};

/**
 * Fake Sql for the puller. The seed runs on a reserved connection, so the fake
 * hands out a reserved handle whose `unsafe` records into the shared `calls`
 * array and whose `release` bumps `released`. `mergeBase` controls the
 * shared-history check:
 *   - a non-empty string → local already descends → reset is skipped
 *   - "" → no common ancestor (fresh node) → reset fires
 *   - throwMergeBase → query errors → treated as no shared history → reset fires
 */
function fakePullSql(opts?: {
  mergeBase?: string;
  throwMergeBase?: boolean;
  failAddWith?: string;
}): FakePullSql {
  const calls: string[] = [];
  const state = { released: 0 };
  const unsafe = async (query: string) => {
    calls.push(query);
    if (opts?.failAddWith && query.includes("dolt_remote")) {
      throw new Error(opts.failAddWith);
    }
    if (query.includes("dolt_merge_base")) {
      if (opts?.throwMergeBase) throw new Error("unrelated histories");
      return [{ base: opts?.mergeBase ?? "" }];
    }
    return [{}];
  };
  return {
    calls,
    get released() {
      return state.released;
    },
    reserve: async () => ({
      unsafe,
      release: () => {
        state.released++;
      },
    }),
  };
}

describe("createDoltgresPuller", () => {
  it("resets local main to origin/main when there is no common ancestor (fresh node)", async () => {
    const sql = fakePullSql({ mergeBase: "" });
    const puller = createDoltgresPuller({
      // biome-ignore lint/suspicious/noExplicitAny: test fake satisfies the narrow surface used by the adapter
      sql: sql as any,
      remoteName: "origin",
      remoteUrl:
        "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator",
    });

    const action = await puller.seedFromRemote();

    expect(action).toBe("reset");
    expect(sql.calls).toHaveLength(4);
    expect(sql.calls[0]).toContain("dolt_remote");
    expect(sql.calls[0]).toContain("add");
    expect(sql.calls[1]).toContain("dolt_fetch");
    expect(sql.calls[1]).toContain("'origin'");
    // explicit branch refspec — pulls all data chunks, not just the commit graph
    expect(sql.calls[1]).toContain("'main'");
    expect(sql.calls[2]).toContain("dolt_merge_base");
    expect(sql.calls[3]).toContain("dolt_reset");
    expect(sql.calls[3]).toContain("'--hard'");
    expect(sql.calls[3]).toContain("'origin/main'");
    // reserved connection is always released
    expect(sql.released).toBe(1);
  });

  it("is a no-op reset when local already shares history with the remote (idempotent re-boot)", async () => {
    const sql = fakePullSql({ mergeBase: "abc1234deadbeef" });
    const puller = createDoltgresPuller({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
    });

    const action = await puller.seedFromRemote();

    // add + fetch + merge_base, but NO reset — local already descends.
    expect(action).toBe("noop");
    expect(sql.calls).toHaveLength(3);
    expect(sql.calls.some((c) => c.includes("dolt_reset"))).toBe(false);
  });

  it("treats a merge-base error as no shared history and resets", async () => {
    const sql = fakePullSql({ throwMergeBase: true });
    const puller = createDoltgresPuller({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
    });

    await puller.seedFromRemote();

    expect(sql.calls).toHaveLength(4);
    expect(sql.calls[3]).toContain("dolt_reset");
  });

  it("swallows 'already exists' during remote add before fetching", async () => {
    const sql = fakePullSql({ failAddWith: "remote already exists" });
    const puller = createDoltgresPuller({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
    });

    // add error is swallowed, so the seed proceeds to its reset path.
    await expect(puller.seedFromRemote()).resolves.toBe("reset");
    // add (swallowed) + fetch + merge_base + reset
    expect(sql.calls).toHaveLength(4);
    expect(sql.calls[1]).toContain("dolt_fetch");
  });

  it("respects the custom branch param when provided", async () => {
    const sql = fakePullSql({ mergeBase: "" });
    const puller = createDoltgresPuller({
      // biome-ignore lint/suspicious/noExplicitAny: test fake
      sql: sql as any,
      remoteName: "origin",
      remoteUrl: "https://example.invalid/x/y",
      branch: "release",
    });

    await puller.seedFromRemote();
    expect(sql.calls[2]).toContain("'release'");
    expect(sql.calls[2]).toContain("'origin/release'");
    expect(sql.calls[3]).toContain("'origin/release'");
  });
});

describe("wrapPushSafe", () => {
  function fakePusher(opts?: { failWith?: string }): DoltgresPusher & {
    calls: number;
  } {
    const state = { calls: 0 };
    return {
      get calls() {
        return state.calls;
      },
      set calls(_: number) {
        state.calls = _;
      },
      async pushBranch() {
        state.calls++;
        if (opts?.failWith) throw new Error(opts.failWith);
      },
    };
  }

  it("invokes onSuccess after a clean pushBranch", async () => {
    const pusher = fakePusher();
    let successes = 0;
    let failures = 0;
    const safe = wrapPushSafe(pusher, {
      onSuccess: () => {
        successes++;
      },
      onFailure: () => {
        failures++;
      },
    });

    await safe();
    expect(pusher.calls).toBe(1);
    expect(successes).toBe(1);
    expect(failures).toBe(0);
  });

  it("invokes onFailure (not onSuccess) when pushBranch throws, and never re-throws", async () => {
    const pusher = fakePusher({ failWith: "permission denied" });
    let successes = 0;
    const caughtErrors: unknown[] = [];
    const safe = wrapPushSafe(pusher, {
      onSuccess: () => {
        successes++;
      },
      onFailure: (err) => {
        caughtErrors.push(err);
      },
    });

    // Fire-and-forget contract: this must not throw, even though the underlying push did.
    await expect(safe()).resolves.toBeUndefined();
    expect(pusher.calls).toBe(1);
    expect(successes).toBe(0);
    expect(caughtErrors).toHaveLength(1);
    expect((caughtErrors[0] as Error).message).toBe("permission denied");
  });

  it("re-runs the pusher on each invocation (no internal memoisation of outcome)", async () => {
    const pusher = fakePusher();
    let successes = 0;
    const safe = wrapPushSafe(pusher, {
      onSuccess: () => {
        successes++;
      },
      onFailure: () => {
        /* noop */
      },
    });

    await safe();
    await safe();
    await safe();
    expect(pusher.calls).toBe(3);
    expect(successes).toBe(3);
  });
});
