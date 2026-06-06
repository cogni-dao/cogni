// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it, vi } from "vitest";
import {
  type GovernanceBootSyncConfig,
  resolveBootSyncConfig,
  runGovernanceBootSync,
} from "./governance-boot-sync";

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const ENABLED: GovernanceBootSyncConfig = {
  port: 3000,
  token: "x".repeat(32),
  enabled: true,
};

const noSleep = () => Promise.resolve();

describe("resolveBootSyncConfig", () => {
  it("defaults port to 3000 and enabled unless explicitly false", () => {
    expect(resolveBootSyncConfig({})).toEqual({
      port: 3000,
      token: null,
      enabled: true,
    });
  });

  it("disables only when GOVERNANCE_SCHEDULES_ENABLED is exactly 'false'", () => {
    expect(
      resolveBootSyncConfig({ GOVERNANCE_SCHEDULES_ENABLED: "false" }).enabled
    ).toBe(false);
    expect(
      resolveBootSyncConfig({ GOVERNANCE_SCHEDULES_ENABLED: "true" }).enabled
    ).toBe(true);
  });

  it("reads port and token from env", () => {
    expect(
      resolveBootSyncConfig({ PORT: "8080", INTERNAL_OPS_TOKEN: "tok" })
    ).toMatchObject({ port: 8080, token: "tok" });
  });
});

describe("runGovernanceBootSync", () => {
  it("skips (no fetch) when disabled", async () => {
    const fetchImpl = vi.fn();
    const logger = fakeLogger();
    await runGovernanceBootSync(
      { ...ENABLED, enabled: false },
      { fetchImpl, logger, sleep: noSleep }
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it("skips + warns (no fetch) when token is missing", async () => {
    const fetchImpl = vi.fn();
    const logger = fakeLogger();
    await runGovernanceBootSync(
      { ...ENABLED, token: null },
      { fetchImpl, logger, sleep: noSleep }
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("succeeds on 200 and posts a bearer token to the loopback endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const logger = fakeLogger();
    await runGovernanceBootSync(ENABLED, { fetchImpl, logger, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain("127.0.0.1:3000");
    expect(url).toContain("/api/internal/ops/governance/schedules/sync");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toMatch(/^Bearer /);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("treats 204 (disabled-noop) as success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 204 });
    const logger = fakeLogger();
    await runGovernanceBootSync(ENABLED, { fetchImpl, logger, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("retries on connection error then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ ok: true, status: 200 });
    const logger = fakeLogger();
    await runGovernanceBootSync(ENABLED, { fetchImpl, logger, sleep: noSleep });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalled();
  });

  it("stops immediately on 4xx (real misconfig) without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const logger = fakeLogger();
    await runGovernanceBootSync(ENABLED, {
      fetchImpl,
      logger,
      sleep: noSleep,
      maxAttempts: 5,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalled();
  });

  it("gives up after maxAttempts and logs an error (fail-soft, no throw)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const logger = fakeLogger();
    await expect(
      runGovernanceBootSync(ENABLED, {
        fetchImpl,
        logger,
        sleep: noSleep,
        maxAttempts: 3,
      })
    ).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(logger.error).toHaveBeenCalled();
  });
});
