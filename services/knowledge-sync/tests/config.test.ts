// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isMirrorEnabled, loadConfig } from "../src/config.js";

const KEYS = [
  "DOLTGRES_URL",
  "DOLTHUB_REMOTE_URL",
  "SYNC_INTERVAL_SECONDS",
  "SYNC_RUN_ON_START",
  "SYNC_NODE",
];

describe("config gating", () => {
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    // loadConfig caches a singleton; reset module state between cases.
    // Reset by re-importing is heavy — instead validate via the parse path here.
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("mirror disabled when DOLTHUB_REMOTE_URL unset (gate-by-secret-presence)", () => {
    expect(
      isMirrorEnabled({
        DOLTGRES_URL: "postgresql://x/knowledge_operator",
        DOLTHUB_REMOTE_URL: undefined,
        SYNC_REMOTE_NAME: "origin",
        SYNC_BRANCH: "main",
        SYNC_NODE: "operator",
        SYNC_INTERVAL_SECONDS: 900,
        SYNC_RUN_ON_START: true,
        SYNC_PUSH_TIMEOUT_MS: 120_000,
        LOG_LEVEL: "info",
        SERVICE_NAME: "knowledge-sync",
        HEALTH_PORT: 9000,
      })
    ).toBe(false);
  });

  it("mirror disabled when DOLTGRES_URL unset", () => {
    expect(
      isMirrorEnabled({
        DOLTGRES_URL: undefined,
        DOLTHUB_REMOTE_URL:
          "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator",
        SYNC_REMOTE_NAME: "origin",
        SYNC_BRANCH: "main",
        SYNC_NODE: "operator",
        SYNC_INTERVAL_SECONDS: 900,
        SYNC_RUN_ON_START: true,
        SYNC_PUSH_TIMEOUT_MS: 120_000,
        LOG_LEVEL: "info",
        SERVICE_NAME: "knowledge-sync",
        HEALTH_PORT: 9000,
      })
    ).toBe(false);
  });

  it("mirror enabled when both present; defaults applied via loadConfig", () => {
    process.env.DOLTGRES_URL = "postgresql://x/knowledge_operator";
    process.env.DOLTHUB_REMOTE_URL =
      "https://doltremoteapi.dolthub.com/cogni-dao/knowledge-operator";
    const cfg = loadConfig();
    expect(isMirrorEnabled(cfg)).toBe(true);
    expect(cfg.SYNC_REMOTE_NAME).toBe("origin");
    expect(cfg.SYNC_BRANCH).toBe("main");
    expect(cfg.SYNC_INTERVAL_SECONDS).toBeGreaterThanOrEqual(60);
  });
});
