// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO
/**
 * Module: `@adapters/server/vcs/gateway-activation.test`
 * Purpose: Prove custody, immutable retry identity and honest native discovery.
 * Scope: Deterministic GitHub boundary fixtures; no network or host effects.
 * Invariants: Unsigned/foreign observations cannot certify activation; incomplete is unknown.
 * Side-effects: none.
 * Links: bug.5570
 * @internal
 */
import type { GatewayIntent } from "@cogni/operator-gateway-activation";
import type { Octokit } from "@octokit/core";
import { describe, expect, it, vi } from "vitest";
import {
  assertGatewayCustodian,
  GithubGatewayActivation,
} from "./gateway-activation";

const op = "b9d19a15-95f9-41b4-bcf5-cd56142c0eb2";
const source = "a".repeat(40),
  transport = "b".repeat(40),
  commit = "c".repeat(40);
const input = {
  operationId: op,
  parentOwner: "cogni-dao",
  parentRepo: "cogni",
};
const bot = { id: 42, login: "cogni-operator[bot]" };
const date = "2026-11-04T22:00:00Z";
const intent: GatewayIntent = {
  version: 1,
  operationId: op,
  target: "litellm-provider-key",
  env: "candidate-a",
  custodian: { owner: "cogni-dao", repo: "cogni", controlEnv: "production" },
  implementationSha: source,
  protocolVersion: 1,
  bindingRef: "cogni/candidate-a/operator/OPENROUTER_API_KEY",
};
function fixture(
  options: { total?: number; runs?: unknown[]; verified?: boolean } = {}
) {
  const request = vi.fn(async (route: string) => {
    if (route.includes("/git/ref/"))
      return { data: { object: { type: "commit", sha: commit } } };
    if (route.endsWith("/commits/{ref}"))
      return {
        data: {
          sha: commit,
          author: bot,
          commit: {
            message: `chore(gateway): persist activation ${op}`,
            committer: { date },
            verification: { verified: options.verified ?? true },
          },
        },
      };
    if (route.includes("/contents/"))
      return {
        data: {
          type: "file",
          encoding: "base64",
          content: Buffer.from(JSON.stringify(intent)).toString("base64"),
        },
      };
    if (route.includes("/branches/"))
      return { data: { protected: true, commit: { sha: transport } } };
    if (route.includes("/compare/")) return { data: { status: "ahead" } };
    if (route.endsWith("/runs"))
      return {
        data: {
          total_count: options.total ?? options.runs?.length ?? 0,
          workflow_runs: options.runs ?? [],
        },
      };
    if (route.endsWith("/dispatches")) return { data: {} };
    throw new Error(`Unexpected boundary ${route}`);
  });
  const gateway = new GithubGatewayActivation(
    { request } as unknown as Octokit,
    input,
    bot,
    () => new Date(date)
  );
  return { gateway, request };
}
const run = {
  id: 9,
  run_attempt: 1,
  event: "workflow_dispatch",
  path: ".github/workflows/candidate-flight-infra.yml",
  display_title: `Gateway ${op} candidate-a ${source} ${transport}`,
  head_sha: transport,
  status: "in_progress",
  created_at: date,
  actor: { id: bot.id },
  html_url: "https://github.com/cogni-dao/cogni/actions/runs/9",
};

describe("canonical gateway authority", () => {
  it("rejects test and foreign custodians before any request", () => {
    expect(() =>
      assertGatewayCustodian(input, {
        hostingEnv: "candidate-a",
        fleetControlEnv: "candidate-a",
        parentOwner: input.parentOwner,
        parentRepo: input.parentRepo,
      })
    ).toThrow("custodian");
    expect(() =>
      assertGatewayCustodian(input, {
        hostingEnv: "production",
        fleetControlEnv: "production",
        parentOwner: "cogni-test-org",
        parentRepo: "cogni-monorepo",
      })
    ).toThrow("custodian");
  });
  it("admits the canonical production custodian", () => {
    expect(() =>
      assertGatewayCustodian(input, {
        hostingEnv: "production",
        fleetControlEnv: "production",
        parentOwner: input.parentOwner,
        parentRepo: input.parentRepo,
      })
    ).not.toThrow();
  });
  it("refuses unsigned durable intent", async () => {
    const { gateway, request } = fixture({ verified: false });
    await expect(gateway.submit("candidate-a")).rejects.toThrow();
    expect(
      request.mock.calls.some(([route]) => route.endsWith("/dispatches"))
    ).toBe(false);
  });
  it("refuses conflicting reuse without another dispatch", async () => {
    const { gateway, request } = fixture();
    await expect(gateway.submit("preview")).rejects.toThrow(
      "idempotency_conflict"
    );
    expect(
      request.mock.calls.some(([route]) => route.endsWith("/dispatches"))
    ).toBe(false);
  });
});

describe("native operation observation", () => {
  it("recovers an interrupted staging ref without replacing its source after main advances", async () => {
    let tagged = false,
      staged = source;
    let persisted: GatewayIntent | undefined;
    const request = vi.fn(
      async (route: string, params: Record<string, unknown>) => {
        if (route.endsWith("/branches/{branch}"))
          return { data: { protected: true, commit: { sha: transport } } };
        if (route.endsWith("/git/ref/{ref}")) {
          if (String(params.ref).startsWith("tags/") && !tagged)
            throw Object.assign(new Error("missing"), { status: 404 });
          return { data: { object: { type: "commit", sha: staged } } };
        }
        if (route.startsWith("POST") && route.endsWith("/git/refs")) {
          if (String(params.ref).startsWith("refs/heads/"))
            throw Object.assign(new Error("already initialized"), {
              status: 422,
            });
          tagged = true;
          return { data: {} };
        }
        if (route.startsWith("GET") && route.includes("/contents/")) {
          if (!persisted)
            throw Object.assign(new Error("not committed yet"), {
              status: 404,
            });
          return {
            data: {
              type: "file",
              encoding: "base64",
              content: Buffer.from(JSON.stringify(persisted)).toString(
                "base64"
              ),
            },
          };
        }
        if (route.startsWith("PUT")) {
          persisted = JSON.parse(
            Buffer.from(String(params.content), "base64").toString("utf8")
          );
          staged = commit;
          return { data: { commit: { sha: commit } } };
        }
        if (route.endsWith("/commits/{ref}"))
          return {
            data: {
              sha: commit,
              author: bot,
              commit: {
                message: `chore(gateway): persist activation ${op}`,
                committer: { date },
                verification: { verified: true },
              },
            },
          };
        if (route.includes("/compare/")) return { data: { status: "ahead" } };
        if (route.endsWith("/runs"))
          return { data: { total_count: 0, workflow_runs: [] } };
        if (route.endsWith("/dispatches") || route.startsWith("DELETE"))
          return { data: {} };
        throw new Error(`Unexpected boundary ${route}`);
      }
    );
    const gateway = new GithubGatewayActivation(
      { request } as unknown as Octokit,
      input,
      bot
    );
    const result = await gateway.submit("candidate-a");
    expect(persisted?.implementationSha).toBe(source);
    expect(result.intent.implementationSha).toBe(source);
    expect(result.transportSha).toBe(transport);
    expect(
      request.mock.calls.filter(([route]) => route.endsWith("/dispatches"))
    ).toHaveLength(1);
  });
  it("does not turn incomplete discovery into idle or permit a resume dispatch", async () => {
    const { gateway, request } = fixture({ total: 1001, runs: [run] });
    expect((await gateway.submit("candidate-a")).status).toBe("unknown");
    expect(
      request.mock.calls.some(([route]) => route.endsWith("/dispatches"))
    ).toBe(false);
  });
  it("checks dispatch actor as well as operation title", async () => {
    const { gateway } = fixture({ runs: [{ ...run, actor: { id: 43 } }] });
    expect((await gateway.status()).status).toBe("unknown");
  });
  it("returns an active native attempt without a duplicate dispatch", async () => {
    const { gateway, request } = fixture({ runs: [run] });
    const observed = await gateway.submit("candidate-a");
    expect(observed).toMatchObject({
      status: "running",
      runId: 9,
      currentState: "unobserved",
    });
    expect(
      request.mock.calls.some(([route]) => route.endsWith("/dispatches"))
    ).toBe(false);
  });
  it.each([
    "status",
    "submit",
  ] as const)("%s prefers an active rerun over newer completed history", async (method) => {
    const { gateway, request } = fixture({
      runs: [
        { ...run, id: 10, status: "completed" },
        { ...run, run_attempt: 2 },
      ],
    });
    const observed =
      method === "status"
        ? await gateway.status()
        : await gateway.submit("candidate-a");
    expect(observed).toMatchObject({
      status: "running",
      runId: 9,
      runUrl: run.html_url,
      currentState: "unobserved",
    });
    expect(
      request.mock.calls.some(
        ([route]) =>
          route.endsWith("/dispatches") || route.endsWith("/artifacts")
      )
    ).toBe(false);
  });
  it("pins original implementation separately from a newer trusted transport", async () => {
    const { gateway, request } = fixture();
    expect((await gateway.submit("candidate-a")).status).toBe("submitted");
    const dispatch = request.mock.calls.find(([route]) =>
      route.endsWith("/dispatches")
    );
    expect(dispatch).toBeDefined();
    // The fixture's public boundary accepts params through Octokit. Inspect the
    // complete call to prove source identity rather than infer it from a title.
    const params = (request.mock.calls as unknown[][]).find((c) =>
      String(c[0]).endsWith("/dispatches")
    )?.[1];
    expect(params).toMatchObject({
      ref: "main",
      inputs: {
        operation_id: op,
        implementation_sha: source,
        transport_sha: transport,
      },
    });
  });
});
