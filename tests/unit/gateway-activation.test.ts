// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `tests/unit/gateway-activation`
 * Purpose: Prove sealed activation intent and recovery after interrupted external effects.
 * Scope: Pure contract and injected-host tests; no credentials, containers or network.
 * Invariants: Unknown outcomes never trigger compensation; replay never replaces intent.
 * Side-effects: none.
 * Links: bug.5570, knowledge/secrets-management
 * @internal
 */
import { describe, expect, it } from "vitest";
import {
  activateGateway,
  type GatewayHostPort,
  GatewayIntentSchema,
  type GatewayObservation,
  gatewayIntentRef,
} from "../../nodes/operator/packages/gateway-activation/src/index";

const intent = {
  version: 1 as const,
  operationId: "b9d19a15-95f9-41b4-bcf5-cd56142c0eb2",
  target: "litellm-provider-key" as const,
  env: "candidate-a" as const,
  custodian: {
    owner: "cogni-dao",
    repo: "cogni",
    controlEnv: "production" as const,
  },
  implementationSha: "a".repeat(40),
  protocolVersion: 1 as const,
  bindingRef: "cogni/candidate-a/operator/OPENROUTER_API_KEY",
};
const observation = (
  phase: GatewayObservation["phase"],
  extra: Partial<GatewayObservation> = {}
): GatewayObservation => ({ operationId: intent.operationId, phase, ...extra });
function host(
  states: GatewayObservation[]
): GatewayHostPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async step(action) {
      calls.push(action);
      const s = states.shift();
      if (!s) throw new Error("Unexpected external effect");
      return s;
    },
  };
}

describe("gateway operation ownership", () => {
  it("binds the same caller identity to one immutable operation ref", () => {
    expect(gatewayIntentRef(intent.operationId)).toBe(
      `tags/cogni-gateway-activation/${intent.operationId}`
    );
    expect(() => gatewayIntentRef("../production")).toThrow();
  });
  it.each([
    "candidate-a",
    "preview",
    "production",
  ] as const)("uses the same sealed contract in %s", (env) => {
    expect(
      GatewayIntentSchema.parse({
        ...intent,
        env,
        bindingRef: `cogni/${env}/operator/OPENROUTER_API_KEY`,
      }).env
    ).toBe(env);
    expect(() =>
      GatewayIntentSchema.parse({
        ...intent,
        env,
        bindingRef: "cogni/production/another-node/OPENROUTER_API_KEY",
      })
    ).toThrow();
  });
  it("refuses a test custodian even if its target label says production", () => {
    expect(() =>
      GatewayIntentSchema.parse({
        ...intent,
        custodian: {
          owner: "cogni-test-org",
          repo: "cogni-monorepo",
          controlEnv: "candidate-a",
        },
      })
    ).toThrow();
  });
  it("refuses raw provider values and caller-selected commands", () => {
    expect(() =>
      GatewayIntentSchema.parse({ ...intent, value: "sk-not-a-real-key" })
    ).toThrow();
    expect(() =>
      GatewayIntentSchema.parse({ ...intent, command: "docker compose down" })
    ).toThrow();
  });
});

describe("interrupted gateway activation", () => {
  it("leaves an unhealthy rollback pending after one compensation attempt", async () => {
    const h = host([
      observation("recreate_started"),
      observation("recreate_started", { failure: "gateway_unhealthy" }),
      observation("rollback_started", { failure: "gateway_unhealthy" }),
    ]);
    expect((await activateGateway(intent, h)).phase).toBe("rollback_started");
    expect(h.calls).toEqual(["observe", "activate", "rollback"]);
  });
  it("resumes after successful recreation without recreating the adopted gateway", async () => {
    const h = host([observation("gateway_verified"), observation("activated")]);
    const result = await activateGateway(intent, h);
    expect(result.phase).toBe("activated");
    expect(h.calls).toEqual(["observe", "commit_receipt"]);
  });
  it("reconciles a lost receipt commit instead of starting a new activation", async () => {
    const h = host([
      observation("receipt_commit_started"),
      observation("activated"),
    ]);
    await activateGateway(intent, h);
    expect(h.calls).toEqual(["observe", "commit_receipt"]);
  });
  it("returns a completed operation as a no-op", async () => {
    const h = host([observation("activated", { noChanges: true })]);
    expect((await activateGateway(intent, h)).noChanges).toBe(true);
    expect(h.calls).toEqual(["observe"]);
  });
  it("does not compensate after an uncertain transport response", async () => {
    const calls: string[] = [];
    const h: GatewayHostPort = {
      async step(action) {
        calls.push(action);
        if (action === "observe") return observation("prepared");
        throw new Error("transport lost");
      },
    };
    await expect(activateGateway(intent, h)).rejects.toThrow("transport lost");
    expect(calls).toEqual(["observe", "install_render"]);
  });
  it("refuses a foreign journal without changing it", async () => {
    const h = host([
      observation("prepared", {
        operationId: "36d7c53d-3a41-4e5d-b44d-cf5fbedbfb24",
      }),
    ]);
    await expect(activateGateway(intent, h)).rejects.toThrow(
      "gateway_operation_identity_conflict"
    );
    expect(h.calls).toEqual(["observe"]);
  });
  it("restores only after a definite unhealthy selected gateway", async () => {
    const h = host([
      observation("recreate_started"),
      observation("rollback_started", { failure: "gateway_unhealthy" }),
      observation("rolled_back"),
    ]);
    expect((await activateGateway(intent, h)).phase).toBe("rolled_back");
    expect(h.calls).toEqual(["observe", "activate", "rollback"]);
  });
  it("refuses superseded binding state without applying a stale key", async () => {
    const h = host([
      observation("conflict", { failure: "binding_superseded" }),
    ]);
    expect((await activateGateway(intent, h)).failure).toBe(
      "binding_superseded"
    );
    expect(h.calls).toEqual(["observe"]);
  });
});
