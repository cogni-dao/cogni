// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import { FakeDoltRemoteAdapter } from "../src/adapters/fake-dolt-remote.js";
import type { KnowledgeSyncConfig } from "../src/config.js";
import { makeLogger } from "../src/observability/index.js";
import { DoltRemotePortError } from "../src/ports/dolt-remote.port.js";
import { startReconciler } from "../src/reconcile.js";

const baseConfig: KnowledgeSyncConfig = {
  DOLTGRES_URL: "postgresql://x/knowledge_operator",
  DOLTHUB_REMOTE_URL:
    "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator",
  SYNC_REMOTE_NAME: "origin",
  SYNC_BRANCH: "main",
  SYNC_NODE: "operator",
  SYNC_INTERVAL_SECONDS: 3600,
  SYNC_RUN_ON_START: false,
  SYNC_PUSH_TIMEOUT_MS: 5_000,
  LOG_LEVEL: "error",
  SERVICE_NAME: "knowledge-sync",
  HEALTH_PORT: 9000,
};

const logger = makeLogger();

describe("fake adapter", () => {
  it("records pushes and passes an AbortSignal through", async () => {
    const fake = new FakeDoltRemoteAdapter();
    const result = await fake.push(AbortSignal.timeout(1000));
    expect(fake.pushCount).toBe(1);
    expect(result.branch).toBe("main");
    expect(fake.signals[0]).toBeInstanceOf(AbortSignal);
  });

  it("throws a typed DoltRemotePortError when failWith is set", async () => {
    const fake = new FakeDoltRemoteAdapter({ failWith: new Error("boom") });
    await expect(fake.push()).rejects.toBeInstanceOf(DoltRemotePortError);
  });
});

describe("reconciler", () => {
  it("pushes via the remote on runOnce", async () => {
    const fake = new FakeDoltRemoteAdapter();
    const r = startReconciler({ config: baseConfig, remote: fake, logger });
    await r.runOnce();
    expect(fake.pushCount).toBe(1);
    await r.stop();
    expect(fake.closed).toBe(true);
  });

  it("no-ops when the mirror is disabled (null remote)", async () => {
    const r = startReconciler({ config: baseConfig, remote: null, logger });
    await r.runOnce();
    await r.stop(); // must not throw
  });

  it("swallows push failures (best-effort, never throws out)", async () => {
    const fake = new FakeDoltRemoteAdapter({
      failWith: new Error("remote down"),
    });
    const r = startReconciler({ config: baseConfig, remote: fake, logger });
    await expect(r.runOnce()).resolves.toBeUndefined();
    expect(fake.pushCount).toBe(1);
    await r.stop();
  });

  it("skips overlapping ticks while a push is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: import("../src/ports/dolt-remote.port.js").DoltRemotePort = {
      kind: "slow",
      async push() {
        await gate;
        return { node: "operator", remote: "r", branch: "main" };
      },
      async close() {},
    };
    const r = startReconciler({ config: baseConfig, remote: slow, logger });
    const first = r.runOnce();
    const second = r.runOnce(); // should join the in-flight push, not start a new one
    release();
    await Promise.all([first, second]);
    await r.stop();
  });
});
