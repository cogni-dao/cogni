// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  type NodeWorkloadDeclaration,
  renderXAkashWorkload,
} from "./render-xakashworkload";

const NODE_ID = "72aa130b-f0ad-495a-a061-9ee1f9c9525d";

const decl = (
  over: Partial<NodeWorkloadDeclaration> = {}
): NodeWorkloadDeclaration => ({
  nodeId: NODE_ID,
  publicHost: "demo-node.example.com",
  services: [
    {
      name: "app",
      image: "ghcr.io/cogni-dao/node-app@sha256:" + "a".repeat(64),
      cpuUnits: 0.5,
      memoryMi: 512,
      storageMi: 1024,
      port: 3000,
      visibility: "public",
    },
  ],
  ...over,
});

describe("renderXAkashWorkload", () => {
  it("renders a valid XAkashWorkload CR mapping the declaration fields", () => {
    const cr = renderXAkashWorkload(decl());
    expect(cr).toEqual({
      apiVersion: "compute.cogni.io/v1alpha1",
      kind: "XAkashWorkload",
      metadata: { name: NODE_ID },
      spec: {
        nodeId: NODE_ID,
        publicHost: "demo-node.example.com",
        providerConfigName: "default",
        services: [
          {
            name: "app",
            image: "ghcr.io/cogni-dao/node-app@sha256:" + "a".repeat(64),
            cpuUnits: 0.5,
            memoryMi: 512,
            storageMi: 1024,
            port: 3000,
            visibility: "public",
          },
        ],
      },
    });
  });

  it("uses nodeId as the deterministic CR name (one paid workload per node)", () => {
    // nodeId is a uuid, which is DNS-1123 valid.
    const cr = renderXAkashWorkload(decl());
    expect(cr.metadata.name).toBe(NODE_ID);
    expect(cr.spec.nodeId).toBe(cr.metadata.name);
  });

  it("honors an explicit CR name override and providerConfigName", () => {
    const cr = renderXAkashWorkload(
      decl({ name: "demo-node-app", providerConfigName: "akash-prod" })
    );
    expect(cr.metadata.name).toBe("demo-node-app");
    expect(cr.spec.providerConfigName).toBe("akash-prod");
  });

  it("is deterministic: same input → identical JSON", () => {
    expect(JSON.stringify(renderXAkashWorkload(decl()))).toBe(
      JSON.stringify(renderXAkashWorkload(decl()))
    );
  });

  it("renders multiple services in order", () => {
    const cr = renderXAkashWorkload(
      decl({
        services: [
          {
            name: "app",
            image: "img/a:1",
            cpuUnits: 0.5,
            memoryMi: 256,
            storageMi: 512,
            port: 3000,
            visibility: "public",
          },
          {
            name: "worker",
            image: "img/b:1",
            cpuUnits: 0.25,
            memoryMi: 128,
            storageMi: 256,
            port: 4000,
            visibility: "private",
          },
        ],
      })
    );
    expect(cr.spec.services.map((s) => s.name)).toEqual(["app", "worker"]);
  });

  it("rejects a missing nodeId", () => {
    expect(() => renderXAkashWorkload(decl({ nodeId: "" }))).toThrow(
      /nodeId is required/
    );
  });

  it("rejects a missing publicHost", () => {
    expect(() => renderXAkashWorkload(decl({ publicHost: "" }))).toThrow(
      /publicHost is required/
    );
  });

  it("rejects an empty services list", () => {
    expect(() => renderXAkashWorkload(decl({ services: [] }))).toThrow(
      /at least one service/
    );
  });

  it("rejects a non-DNS-1123 CR name", () => {
    expect(() => renderXAkashWorkload(decl({ name: "Bad_Name" }))).toThrow(
      /DNS-1123/
    );
  });

  it("rejects a duplicate service name", () => {
    expect(() =>
      renderXAkashWorkload(
        decl({
          services: [
            {
              name: "app",
              image: "img/a:1",
              cpuUnits: 0.5,
              memoryMi: 256,
              storageMi: 512,
              port: 3000,
              visibility: "public",
            },
            {
              name: "app",
              image: "img/b:1",
              cpuUnits: 0.5,
              memoryMi: 256,
              storageMi: 512,
              port: 3001,
              visibility: "private",
            },
          ],
        })
      )
    ).toThrow(/duplicate service name/);
  });

  it("rejects a non-positive resource field", () => {
    expect(() =>
      renderXAkashWorkload(
        decl({
          services: [
            {
              name: "app",
              image: "img/a:1",
              cpuUnits: 0,
              memoryMi: 256,
              storageMi: 512,
              port: 3000,
              visibility: "public",
            },
          ],
        })
      )
    ).toThrow(/cpuUnits must be a positive number/);
  });

  it("rejects an invalid visibility", () => {
    expect(() =>
      renderXAkashWorkload(
        decl({
          services: [
            {
              name: "app",
              image: "img/a:1",
              cpuUnits: 0.5,
              memoryMi: 256,
              storageMi: 512,
              port: 3000,
              // @ts-expect-error deliberately invalid visibility
              visibility: "world",
            },
          ],
        })
      )
    ).toThrow(/visibility must be/);
  });

  it("rejects zero public services (Akash needs exactly one ingress)", () => {
    expect(() =>
      renderXAkashWorkload(
        decl({
          services: [
            {
              name: "worker",
              image: "img/a:1",
              cpuUnits: 0.5,
              memoryMi: 256,
              storageMi: 512,
              port: 3000,
              visibility: "private",
            },
          ],
        })
      )
    ).toThrow(/exactly one public service is required \(found 0\)/);
  });

  it("rejects two public services", () => {
    expect(() =>
      renderXAkashWorkload(
        decl({
          services: [
            {
              name: "app",
              image: "img/a:1",
              cpuUnits: 0.5,
              memoryMi: 256,
              storageMi: 512,
              port: 3000,
              visibility: "public",
            },
            {
              name: "app2",
              image: "img/b:1",
              cpuUnits: 0.5,
              memoryMi: 256,
              storageMi: 512,
              port: 3001,
              visibility: "public",
            },
          ],
        })
      )
    ).toThrow(/exactly one public service is required \(found 2\)/);
  });
});
