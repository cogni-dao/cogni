// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@features/node-deploy/declarations.test`
 * Purpose: Prove the additive `deployment.workloads[]` schema and that the operator's REAL checked-in
 *   canary declarations resolve for every environment (task.5400).
 * Side-effects: filesystem read of the root `.cogni/repo-spec.yaml`
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  extractNodeServices,
  extractNodeWorkloads,
  hasDeclaredNodeDeployment,
  parseRepoSpec,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { parse as parseYaml, stringify } from "yaml";

import {
  DeclarationError,
  hostForEnv,
  resolveWorkloadDeclaration,
} from "./declarations";

const NODE_ID = "4ff8eac1-4eba-4ed0-931b-b1fe4f64713d";
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT_SPEC = readFileSync(
  path.resolve(here, "../../../../../../.cogni/repo-spec.yaml"),
  "utf8"
);

describe("the operator's checked-in canary declarations", () => {
  it("parse through the repo-spec schema without becoming an app-tier deployment", () => {
    const spec = parseRepoSpec(ROOT_SPEC);
    expect(extractNodeWorkloads(spec).map((w) => w.name)).toEqual([
      "canary-db",
      "canary",
    ]);
    // a workloads-only block is NOT a declared off-cluster deployment
    expect(hasDeclaredNodeDeployment(spec)).toBe(false);
    expect(extractNodeServices(spec)).toHaveLength(1);
    expect(extractNodeServices(spec)[0]?.name).toBe("app");
  });

  it("canary-db: digest-pinned TLS postgres, 2Gi persistent, tcp 5432 global, not exclusive", () => {
    const w = resolveWorkloadDeclaration({
      repoSpecText: ROOT_SPEC,
      nodeId: NODE_ID,
      env: "production",
      workload: "canary-db",
    });
    expect(w).toMatchObject({
      kind: "state",
      port: 5432,
      cpu: 0.5,
      memoryMi: 512,
      expose: { tcp: { global: true } },
      persistent: { sizeMi: 2048, mountPath: "/var/lib/postgresql/data" },
      exclusive: false,
    });
    expect(w.image).toMatch(/^postgres:16@sha256:[0-9a-f]{64}$/);
    expect(w.command?.join(" ")).toContain("ssl=on");
    expect(w.env.PGDATA).toBe("/var/lib/postgresql/data/pgdata");
  });

  it("canary: python alpine digest, a real HTTP server (the nc loop 502d behind some ingresses), port 8080 -> 80, bound to canary-db", () => {
    const w = resolveWorkloadDeclaration({
      repoSpecText: ROOT_SPEC,
      nodeId: NODE_ID,
      env: "production",
      workload: "canary",
    });
    expect(w.image).toBe(
      "python:3.12-alpine@sha256:e6dae589c1c05976188fd3bd019afd091445fc533ed2ea29001beddc7368a9c8"
    );
    expect(w).toMatchObject({
      kind: "app",
      port: 8080,
      cpu: 0.25,
      memoryMi: 256,
      exclusive: false,
      bindings: [{ env: "DATABASE_URL", workload: "canary-db" }],
      health: { version: "/version", ready: "/readyz" },
    });
    expect(w.command?.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(w.command?.[2]).toContain("ThreadingHTTPServer");
    expect(w.command?.[2]).toContain('("0.0.0.0", 8080)');
    expect(w.command?.[2]).toContain('"buildSha": SHA');
  });

  it("hosts follow the environment: production / -test / -preview / -dev", () => {
    const host = (env: string) => {
      const w = resolveWorkloadDeclaration({
        repoSpecText: ROOT_SPEC,
        nodeId: NODE_ID,
        env,
        workload: "canary",
      });
      return "http" in w.expose ? w.expose.http.host : undefined;
    };
    expect(host("production")).toBe("node-deploy-canary.cognidao.org");
    expect(host("candidate-a")).toBe("node-deploy-canary-test.cognidao.org");
    expect(host("preview")).toBe("node-deploy-canary-preview.cognidao.org");
    expect(host("dev")).toBe("node-deploy-canary-dev.cognidao.org");
    expect(() => hostForEnv("a.example.org", "mars")).toThrow(
      /unknown environment/
    );
  });

  it("refuses an exclusive app: blue and green overlap and there is no fence yet (CD6)", () => {
    const text = ROOT_SPEC.replace(
      /(name: canary\n[\s\S]*?exclusive: )false/,
      "$1true"
    );
    expect(text).not.toBe(ROOT_SPEC);
    expect(() =>
      resolveWorkloadDeclaration({
        repoSpecText: text,
        nodeId: NODE_ID,
        env: "production",
        workload: "canary",
      })
    ).toThrow(expect.objectContaining({ code: "exclusive_unsupported" }));
  });

  it("refuses another node's id and an undeclared workload", () => {
    const call = (nodeId: string, workload: string) =>
      resolveWorkloadDeclaration({
        repoSpecText: ROOT_SPEC,
        nodeId,
        env: "production",
        workload,
      });
    expect(() =>
      call("00000000-0000-4000-8000-000000000001", "canary")
    ).toThrow(expect.objectContaining({ code: "node_mismatch" }));
    expect(() => call(NODE_ID, "nope")).toThrow(
      expect.objectContaining({ code: "workload_not_declared" })
    );
    expect(() =>
      resolveWorkloadDeclaration({
        repoSpecText: "{{ not yaml",
        nodeId: NODE_ID,
        env: "production",
        workload: "canary",
      })
    ).toThrow(DeclarationError);
  });
});

describe("deployment.workloads schema guards", () => {
  const base = () => {
    const doc = parseYaml(ROOT_SPEC) as {
      deployment: { workloads: Record<string, unknown>[] };
    };
    return doc;
  };
  const parseWith = (mutate: (doc: ReturnType<typeof base>) => void) => {
    const doc = base();
    mutate(doc);
    return () => parseRepoSpec(stringify(doc));
  };

  it("an image that is not pinned by digest is refused", () => {
    expect(
      parseWith((d) => {
        d.deployment.workloads[1] = {
          ...d.deployment.workloads[1],
          image: "postgres:16-alpine",
        };
      })
    ).toThrow(/pinned by digest/);
  });

  it("`exclusive` is required: there is no default", () => {
    expect(
      parseWith((d) => {
        const { exclusive: _drop, ...rest } = d.deployment
          .workloads[1] as Record<string, unknown>;
        d.deployment.workloads[1] = rest;
      })
    ).toThrow(/exclusive/);
  });

  it("a state workload must expose tcp and declare persistent storage", () => {
    expect(
      parseWith((d) => {
        d.deployment.workloads[0] = {
          ...d.deployment.workloads[0],
          expose: { http: { host: "node-deploy-canary.cognidao.org" } },
        };
      })
    ).toThrow(/state workload must expose a global tcp port/);
    expect(
      parseWith((d) => {
        const { persistent: _drop, ...rest } = d.deployment
          .workloads[0] as Record<string, unknown>;
        d.deployment.workloads[0] = rest;
      })
    ).toThrow(/persistent storage/);
  });

  it("a binding must name a different declared state workload", () => {
    expect(
      parseWith((d) => {
        d.deployment.workloads[1] = {
          ...d.deployment.workloads[1],
          bindings: [{ env: "DATABASE_URL", workload: "ghost" }],
        };
      })
    ).toThrow(/must name a different declared state workload/);
    expect(
      parseWith((d) => {
        d.deployment.workloads[1] = {
          ...d.deployment.workloads[1],
          bindings: [{ env: "DATABASE_URL", workload: "canary" }],
        };
      })
    ).toThrow(/must name a different declared state workload/);
  });

  it("an app must declare health paths and an http host", () => {
    expect(
      parseWith((d) => {
        const { health: _drop, ...rest } = d.deployment.workloads[1] as Record<
          string,
          unknown
        >;
        d.deployment.workloads[1] = rest;
      })
    ).toThrow(/health/);
  });

  it("existing app-tier declarations are unchanged: a services-only block still parses", () => {
    const doc = base() as unknown as { deployment: Record<string, unknown> };
    delete doc.deployment.workloads;
    expect(() => parseRepoSpec(stringify(doc))).toThrow(
      /at least one service or workload/
    );
  });
});
