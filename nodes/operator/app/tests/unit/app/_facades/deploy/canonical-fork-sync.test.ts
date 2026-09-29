// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/tests/unit/app/_facades/deploy/canonical-fork-sync`
 * Purpose: Prove template pushes terminate in an observable no-write state while automatic fork source
 *   sync is disabled.
 * Scope: Pure payload narrowing + structured logging. No GitHub, DB, or deploy-plane fake exists because
 *   the production facade must not resolve or call one.
 * Links: src/app/_facades/deploy/canonical-fork-sync.server.ts, bug.5304
 * @internal
 */

import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";

import {
  dispatchCanonicalForkSync,
  extractTemplateMainPush,
} from "@/app/_facades/deploy/canonical-fork-sync.server";
import type { ServerEnv } from "@/shared/env";

const pushPayload = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  after: "a".repeat(40),
  repository: {
    name: "node-template",
    default_branch: "main",
    owner: { login: "Cogni-DAO" },
    ...((over.repository as object) ?? {}),
  },
  ...over,
});

function fakeLogger(): Logger {
  return {
    warn: vi.fn(),
  } as unknown as Logger;
}

function env(templateOwner?: string): ServerEnv {
  return {
    ...(templateOwner ? { NODE_TEMPLATE_OWNER: templateOwner } : {}),
  } as ServerEnv;
}

describe("extractTemplateMainPush", () => {
  it("accepts a node-template default-branch push", () => {
    expect(extractTemplateMainPush(pushPayload(), "Cogni-DAO")).toEqual({
      sourceOwner: "Cogni-DAO",
      sourceRepo: "node-template",
      defaultBranch: "main",
      afterSha: "a".repeat(40),
    });
  });

  it("rejects a different owner", () => {
    expect(extractTemplateMainPush(pushPayload(), "cogni-test-org")).toBeNull();
  });

  it("rejects a non-template repo", () => {
    expect(
      extractTemplateMainPush(
        pushPayload({ repository: { name: "blue" } }),
        "Cogni-DAO"
      )
    ).toBeNull();
  });

  it("rejects a push to a non-default branch", () => {
    expect(
      extractTemplateMainPush(
        pushPayload({ ref: "refs/heads/feature/x" }),
        "Cogni-DAO"
      )
    ).toBeNull();
  });

  it("rejects malformed payloads", () => {
    expect(extractTemplateMainPush({}, "Cogni-DAO")).toBeNull();
  });
});

describe("dispatchCanonicalForkSync", () => {
  it("records a recognized push without resolving a deploy plane or writing a fork", () => {
    const log = fakeLogger();

    dispatchCanonicalForkSync(pushPayload(), env("Cogni-DAO"), log);

    expect(log.warn).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(
      {
        event: "node_template_fork_sync_disabled",
        source: "Cogni-DAO/node-template@aaaaaaaa",
        reason: "automatic fork source sync is retired after bug.5304",
      },
      "node_template_fork_sync_disabled"
    );
  });

  it("stays silent for unrelated pushes or an unconfigured template owner", () => {
    const log = fakeLogger();

    dispatchCanonicalForkSync(
      pushPayload({ repository: { name: "poly" } }),
      env("Cogni-DAO"),
      log
    );
    dispatchCanonicalForkSync(pushPayload(), env(), log);

    expect(log.warn).not.toHaveBeenCalled();
  });
});
