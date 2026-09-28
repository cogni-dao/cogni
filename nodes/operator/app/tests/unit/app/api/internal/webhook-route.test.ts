// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/app/api/internal/webhook-route`
 * Purpose: Pin the webhook verification boundary and fresh-node forced-refresh routing behavior.
 * Scope: Route shell with container, routing, persistence, delivery, and dispatch mocked; no IO.
 * Invariants: WEBHOOK_VERIFY_BEFORE_ROUTE, UNIQUE_ROUTE_OR_NO_WRITE, FRESH_NODE_FORCE_REFRESH.
 * Side-effects: none
 * Links: src/app/api/internal/webhooks/[source]/route.ts, bug.5052
 * @public
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fakes = vi.hoisted(() => ({
  verify: vi.fn(),
  normalize: vi.fn(),
  catalogLookup: vi.fn(),
  insert: vi.fn(),
  deliver: vi.fn(),
  review: vi.fn(),
  preview: vi.fn(),
  sync: vi.fn(),
  signal: vi.fn(),
}));

const logger = vi.hoisted(() => {
  const instance = {
    child: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  instance.child.mockReturnValue(instance);
  return instance;
});

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({
    attributionStore: { insertIngestionReceipts: fakes.insert },
    webhookRegistrations: new Map([
      [
        "github",
        {
          source: "github",
          version: "test.v1",
          webhook: {
            supportedEvents: ["issues"],
            verify: fakes.verify,
            normalize: fakes.normalize,
          },
        },
      ],
    ]),
    receiptDelivery: { deliverReceipts: fakes.deliver },
  }),
  resolveAttributionProfileResolver: () => ({
    resolveRepoRoute: fakes.catalogLookup,
  }),
}));
vi.mock("@/app/_facades/review/dispatch.server", () => ({
  dispatchPrReview: fakes.review,
}));
vi.mock("@/app/_facades/deploy/node-preview-promote.server", () => ({
  dispatchNodePreviewPromote: fakes.preview,
}));
vi.mock("@/app/_facades/deploy/canonical-fork-sync.server", () => ({
  dispatchCanonicalForkSync: fakes.sync,
}));
vi.mock("@/features/governance/services/signal-dispatch", () => ({
  dispatchSignalExecution: fakes.signal,
}));
vi.mock("@/shared/config", () => ({
  getNodeId: () => "operator-node",
  getNodeName: () => "operator",
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ GH_WEBHOOK_SECRET: "webhook-secret" }),
}));
vi.mock("@/shared/observability", () => ({ makeLogger: () => logger }));

import { POST } from "@/app/api/internal/webhooks/[source]/route";

function githubRequest(payload: unknown, eventType: string): Request {
  return new Request("https://test.local/api/internal/webhooks/github", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": eventType,
      "x-hub-signature-256": "sha256=invalid",
    },
    body: JSON.stringify(payload),
  });
}

async function post(
  payload: unknown,
  eventType = "pull_request"
): Promise<Response> {
  return POST(githubRequest(payload, eventType), {
    params: Promise.resolve({ source: "github" }),
  });
}

describe("POST internal webhook verification boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    logger.child.mockReturnValue(logger);
  });

  it("rejects an invalid signature before malformed routing input can cause any side effect", async () => {
    fakes.verify.mockResolvedValue(false);

    const response = await post({
      repository: { full_name: { malformed: true } },
    });

    expect(response.status).toBe(401);
    expect(fakes.verify).toHaveBeenCalledOnce();
    expect(fakes.catalogLookup).not.toHaveBeenCalled();
    expect(fakes.normalize).not.toHaveBeenCalled();
    expect(fakes.insert).not.toHaveBeenCalled();
    expect(fakes.deliver).not.toHaveBeenCalled();
    expect(fakes.review).not.toHaveBeenCalled();
    expect(fakes.preview).not.toHaveBeenCalled();
    expect(fakes.sync).not.toHaveBeenCalled();
    expect(fakes.signal).not.toHaveBeenCalled();
  });

  it("uses push as the one node-preview signal (direct + merge-queue safe)", async () => {
    fakes.verify.mockResolvedValue(true);
    fakes.catalogLookup.mockResolvedValue({
      status: "matched",
      repo: "cogni-dao/poly",
      target: {
        id: "poly-id",
        slug: "poly",
        repo: { owner: "cogni-dao", repo: "poly" },
      },
    });
    fakes.normalize.mockResolvedValue([]);

    const payload = {
      ref: "refs/heads/main",
      after: "d".repeat(40),
      repository: {
        full_name: "cogni-dao/poly",
        name: "poly",
        default_branch: "main",
        owner: { login: "cogni-dao" },
      },
    };
    const response = await post(payload, "push");

    expect(response.status).toBe(200);
    expect(fakes.preview).toHaveBeenCalledOnce();
    expect(fakes.preview).toHaveBeenCalledWith(
      payload,
      expect.anything(),
      logger
    );
    expect(fakes.sync).toHaveBeenCalledOnce();
    expect(fakes.review).not.toHaveBeenCalled();
  });

  it("does not acknowledge a push when the promotion dispatch is unobserved", async () => {
    fakes.verify.mockResolvedValue(true);
    fakes.catalogLookup.mockResolvedValue({
      status: "matched",
      repo: "cogni-dao/poly",
      target: {
        id: "poly-id",
        slug: "poly",
        repo: { owner: "cogni-dao", repo: "poly" },
      },
    });
    fakes.normalize.mockResolvedValue([]);
    fakes.preview.mockRejectedValueOnce(new Error("run identity missing"));

    const response = await post(
      {
        ref: "refs/heads/main",
        after: "d".repeat(40),
        repository: {
          full_name: "cogni-dao/poly",
          name: "poly",
          default_branch: "main",
          owner: { login: "cogni-dao" },
        },
      },
      "push"
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: "Ingestion failed",
    });
  });

  it("force-refreshes a warm pre-spawn snapshot and routes the first verified fresh-node event once", async () => {
    fakes.verify.mockResolvedValue(true);
    fakes.catalogLookup
      .mockResolvedValueOnce({
        status: "unclaimed",
        repo: "cogni-test-org/fresh-node",
      })
      .mockResolvedValueOnce({
        status: "matched",
        repo: "cogni-test-org/fresh-node",
        target: {
          id: "fresh-node-id",
          slug: "fresh-node",
          repo: { owner: "cogni-test-org", repo: "fresh-node" },
        },
      });
    fakes.normalize.mockResolvedValue([
      {
        id: "github:issue:cogni-test-org/fresh-node:1:opened",
        source: "github",
        eventType: "issue_opened",
        platformUserId: "123",
        platformLogin: "contributor",
        artifactUrl: "https://github.com/cogni-test-org/fresh-node/issues/1",
        metadata: null,
        payloadHash: "a".repeat(64),
        eventTime: new Date("2026-08-18T00:00:00.000Z"),
      },
    ]);

    const response = await post(
      { repository: { full_name: "cogni-test-org/fresh-node" } },
      "issues"
    );

    expect(response.status).toBe(200);
    expect(fakes.catalogLookup).toHaveBeenNthCalledWith(
      1,
      "cogni-test-org/fresh-node",
      undefined
    );
    expect(fakes.catalogLookup).toHaveBeenNthCalledWith(
      2,
      "cogni-test-org/fresh-node",
      { forceRefresh: true }
    );
    expect(fakes.insert).not.toHaveBeenCalled();
    expect(fakes.deliver).toHaveBeenCalledOnce();
    expect(fakes.deliver).toHaveBeenCalledWith(
      { nodeId: "fresh-node-id", slug: "fresh-node" },
      "github",
      [expect.objectContaining({ nodeId: "fresh-node-id" })]
    );
  });

  it("fails loud and write-free when the one forced refresh remains unclaimed", async () => {
    fakes.verify.mockResolvedValue(true);
    fakes.catalogLookup.mockResolvedValue({
      status: "unclaimed",
      repo: "cogni-test-org/fresh-node",
    });
    fakes.normalize.mockResolvedValue([
      {
        id: "github:issue:cogni-test-org/fresh-node:1:opened",
        source: "github",
        eventType: "issue_opened",
        platformUserId: "123",
        platformLogin: "contributor",
        artifactUrl: "https://github.com/cogni-test-org/fresh-node/issues/1",
        metadata: null,
        payloadHash: "a".repeat(64),
        eventTime: new Date("2026-08-18T00:00:00.000Z"),
      },
    ]);

    const response = await post(
      { repository: { full_name: "cogni-test-org/fresh-node" } },
      "issues"
    );

    expect(response.status).toBe(503);
    expect(fakes.catalogLookup).toHaveBeenCalledTimes(2);
    expect(fakes.insert).not.toHaveBeenCalled();
    expect(fakes.deliver).not.toHaveBeenCalled();
  });
});
