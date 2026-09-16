// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";
import { buildNodeWorkloadSpec } from "./node-workload-spec";

const BASE_INPUT = {
  slug: "sample-node",
  nodeId: "72aa130b-f0ad-495a-a061-9ee1f9c9525d",
  image: "ghcr.io/cogni-dao/sample-node:sha-abc",
  port: 3200,
  publicUrl: "https://sample-node.example.org",
  env: { DATABASE_URL: "postgresql://x", AUTH_SECRET: "caller-secret" },
} as const;

describe("buildNodeWorkloadSpec", () => {
  it("builds an app-only single-service workload (APP_ONLY_NO_INFRA)", () => {
    const spec = buildNodeWorkloadSpec(BASE_INPUT);
    expect(spec.services).toHaveLength(1);
    const app = spec.services[0];
    expect(app?.name).toBe("app");
    expect(app?.image).toBe(BASE_INPUT.image);
    expect(app?.command).toBeUndefined();
    expect(app?.expose).toEqual([{ port: 3200, as: 80, global: true }]);
    expect(app).toMatchObject({
      cpuUnits: 2,
      memoryMi: 2048,
      storageMi: 2048,
    });
  });

  it("preserves caller env while canonical identity config stays authoritative", () => {
    const env = buildNodeWorkloadSpec(BASE_INPUT).services[0]?.env ?? {};
    expect(env.AUTH_SECRET).toBe("caller-secret");
    expect(env.DATABASE_URL).toBe("postgresql://x");
    expect(env.COGNI_REPO_PATH).toBe("/app");
    expect(env.NEXTAUTH_URL).toBe(BASE_INPUT.publicUrl);
    expect(env.APP_BASE_URL).toBe(BASE_INPUT.publicUrl);
    expect(env.AUTH_TRUST_HOST).toBe("true");
    expect(env.NODE_NAME).toBe("sample-node");
  });

  it("propagates ingress hosts", () => {
    const spec = buildNodeWorkloadSpec({
      ...BASE_INPUT,
      hosts: ["sample-node.example.org"],
    });
    expect(spec.services[0]?.expose?.[0]?.hosts).toEqual([
      "sample-node.example.org",
    ]);
  });

  it("logPush wires the pump: valid base64 JS, all labels, piped command", () => {
    const spec = buildNodeWorkloadSpec({
      ...BASE_INPUT,
      logPush: {
        url: "https://logs.example.net/loki/api/v1/push",
        username: "123",
        password: "wr1te-only",
        env: "candidate-a",
      },
    });
    const app = spec.services[0];
    const env = app?.env ?? {};
    // command materializes the base64 pump then pipes server stdout through it
    expect(app?.command?.join(" ")).toContain("base64 -d");
    expect(app?.command?.join(" ")).toContain("| node /tmp/loki-pump.js");
    const pumpSrc = Buffer.from(env.LOKI_PUMP_B64 ?? "", "base64").toString(
      "utf8"
    );
    expect(() => new Function(pumpSrc)).not.toThrow(); // parseable JS
    expect(pumpSrc).toContain("LOKI_PUSH_URL");
    expect(env.LOKI_PUSH_URL).toBe("https://logs.example.net/loki/api/v1/push");
    expect(env.LOKI_PUSH_USER).toBe("123");
    expect(env.LOKI_PUSH_PASSWORD).toBe("wr1te-only");
    expect(env.LOKI_PUSH_ENV).toBe("candidate-a");
    expect(env.LOKI_PUSH_NODE).toBe(BASE_INPUT.nodeId);
  });

  it("no logPush -> no pump env, no command override", () => {
    const app = buildNodeWorkloadSpec(BASE_INPUT).services[0];
    expect(app?.env?.LOKI_PUMP_B64).toBeUndefined();
    expect(app?.command).toBeUndefined();
  });

  it("resources override applies", () => {
    const spec = buildNodeWorkloadSpec({
      ...BASE_INPUT,
      resources: { cpuUnits: 1, memoryMi: 2048, storageMi: 4096 },
    });
    expect(spec.services[0]).toMatchObject({
      cpuUnits: 1,
      memoryMi: 2048,
      storageMi: 4096,
    });
  });
});
