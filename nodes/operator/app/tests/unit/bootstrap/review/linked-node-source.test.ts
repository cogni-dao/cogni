// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/bootstrap/review/linked-node-source`
 * Purpose: The linked-node reader emits exactly ONE terminal `agent.node_call` per run: info on success, warn with a
 *   stable errorCode on every failure, including failures before any fetch (story.0038).
 * Scope: Fakes for the registry, broker, transport, link service and GitHub plane; no IO.
 * Side-effects: none
 * @internal
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const NODE = "22222222-2222-4222-8222-222222222222";
const subject = {
  nodeId: NODE,
  owner: "org",
  repo: "repo",
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
};
const h = vi.hoisted(() => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  resolveNodeRef: vi.fn(),
  resolveServiceConnection: vi.fn(),
  get: vi.fn(),
  markKeyRejected: vi.fn(),
  readNodeMission: vi.fn(),
  links: undefined as unknown,
  resolver: undefined as unknown,
}));
h.links = { markKeyRejected: h.markKeyRejected };
h.resolver = { resolveServiceConnection: h.resolveServiceConnection };

vi.mock("@/bootstrap/container", () => ({
  getContainer: () => ({ serviceConnectionResolver: h.resolver }),
  resolveServiceDb: () => ({}),
}));
vi.mock("@/bootstrap/node-service-links", () => ({
  getNodeServiceLinkService: () => h.links,
}));
vi.mock("@/features/nodes/node-lookup", () => ({
  resolveNodeRef: h.resolveNodeRef,
}));
vi.mock("@/shared/env", () => ({
  serverEnv: () => ({ APP_BASE_URL: "https://test.example.org" }),
}));
vi.mock("@/shared/observability", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/observability")>()),
  makeLogger: () => h.log,
}));
vi.mock("@/adapters/server", () => ({
  createNodeHostTransport: () => ({ get: h.get }),
  selectArchitectEntryId: () => null,
}));
vi.mock("@/bootstrap/review/resolve-review-route", () => ({
  createReviewGithubPlane: () => ({ readNodeMission: h.readNodeMission }),
}));

import { createLinkedNodeSourceReader } from "@/bootstrap/review/linked-node-source";

const terminalCalls = () =>
  [...h.log.info.mock.calls, ...h.log.warn.mock.calls].filter(
    (c) => (c[0] as { event?: string }).event === "agent.node_call"
  );

describe("linked node source: one terminal agent.node_call per run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.resolveNodeRef.mockResolvedValue({
      nodeId: NODE,
      slug: "x",
      deployEnvs: ["candidate-a"],
    });
    h.resolveServiceConnection.mockResolvedValue({
      connectionId: "conn-1",
      credentials: { accessToken: "cogni_ag_sk_v2_K" },
    });
    h.readNodeMission.mockResolvedValue("Run X.");
  });

  it("a failure BEFORE any fetch (not linked) warns once with errorCode node_not_linked", async () => {
    h.resolveServiceConnection.mockRejectedValue(new Error("none"));
    await expect(createLinkedNodeSourceReader()(subject)).rejects.toMatchObject(
      { code: "node_not_linked" }
    );
    const calls = terminalCalls();
    expect(calls).toHaveLength(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "agent.node_call",
        outcome: "error",
        errorCode: "node_not_linked",
        calls: 0,
      }),
      "agent.node_call"
    );
    expect(h.log.info).not.toHaveBeenCalled();
  });

  it("an unreadable hub (403) warns once with errorCode node_hub_unreadable and counts the call", async () => {
    h.get.mockResolvedValue({ ok: true, status: 403, body: "" });
    await expect(createLinkedNodeSourceReader()(subject)).rejects.toMatchObject(
      { code: "node_hub_unreadable" }
    );
    expect(terminalCalls()).toHaveLength(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        errorCode: "node_hub_unreadable",
        calls: 1,
        notOk: 1,
        audienceHost: "x-test.example.org",
        credentialId: "conn-1",
      }),
      "agent.node_call"
    );
  });

  it("a 401 marks the link and warns once with errorCode node_key_rejected", async () => {
    h.get.mockResolvedValue({ ok: true, status: 401, body: "" });
    await expect(createLinkedNodeSourceReader()(subject)).rejects.toMatchObject(
      { code: "node_key_rejected" }
    );
    expect(h.markKeyRejected).toHaveBeenCalled();
    expect(terminalCalls()).toHaveLength(1);
    expect(h.log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "node_key_rejected" }),
      "agent.node_call"
    );
  });

  it("success logs ONE info line with counts and no errorCode", async () => {
    h.get.mockImplementation(async ({ path }: { path: string }) =>
      path.endsWith("/index")
        ? {
            ok: true,
            status: 200,
            body: JSON.stringify({
              items: [
                { id: "r1", domain: "d", entryType: "rule", useWhen: "u" },
                { id: "r2", domain: "d", entryType: "rule", useWhen: "u" },
              ],
            }),
          }
        : { ok: true, status: 200, body: JSON.stringify({ content: "BODY" }) }
    );
    const source = await createLinkedNodeSourceReader()(subject);
    expect(source.rules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(terminalCalls()).toHaveLength(1);
    const fields = h.log.info.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(fields).toMatchObject({ outcome: "success", calls: 3, ok: 3 });
    expect(fields).not.toHaveProperty("errorCode");
    expect(h.log.warn).not.toHaveBeenCalled();
  });
});
