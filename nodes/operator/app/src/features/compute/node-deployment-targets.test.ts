// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { describe, expect, it } from "vitest";

import {
  resolveDeploymentTargets,
  resolvePromoteDeploymentTargets,
} from "./node-deployment-targets";

describe("resolveDeploymentTargets", () => {
  it("keeps omitted placement on k3s and separates explicit off-cluster nodes", () => {
    expect(
      resolveDeploymentTargets({
        catalogRows: [
          {
            name: "node-template",
            type: "node",
            envs: ["candidate-a"],
          },
          {
            name: "toks4",
            type: "node",
            envs: ["candidate-a"],
            source_repo: "https://github.com/cogni-dao/toks4",
            source_sha: "0123456789abcdef0123456789abcdef01234567",
            deployment_provider: { "candidate-a": "akash" },
          },
          { name: "scheduler-worker", type: "service" },
        ],
        environment: "candidate-a",
        flightTargets: ["node-template", "toks4", "scheduler-worker"],
      })
    ).toEqual({
      deployment: ["node-template", "toks4"],
      substrate: ["node-template", "toks4"],
      offCluster: ["toks4"],
      providers: {
        "node-template": "k3s",
        toks4: "akash",
        "scheduler-worker": "k3s",
      },
      k3s: ["node-template", "scheduler-worker"],
      k3sNodes: ["node-template"],
      sourceRepositories: { toks4: "cogni-dao/toks4" },
      sourceShas: { toks4: "0123456789abcdef0123456789abcdef01234567" },
    });
  });

  it("never expands a node-ref flight to sibling catalog rows", () => {
    const catalogRows = [
      { name: "operator", type: "node", envs: ["candidate-a"] },
      {
        name: "toks4",
        type: "node",
        envs: ["candidate-a"],
        source_repo: "https://github.com/cogni-dao/toks4",
        source_sha: "0123456789abcdef0123456789abcdef01234567",
        deployment_provider: { "candidate-a": "akash" },
      },
    ];

    expect(
      resolveDeploymentTargets({
        catalogRows,
        environment: "candidate-a",
        flightTargets: ["operator"],
      })
    ).toEqual({
      deployment: ["operator"],
      substrate: ["operator"],
      offCluster: [],
      providers: { operator: "k3s" },
      k3s: ["operator"],
      k3sNodes: ["operator"],
      sourceRepositories: {},
      sourceShas: {},
    });
    expect(
      resolveDeploymentTargets({
        catalogRows,
        environment: "candidate-a",
        flightTargets: ["toks4"],
      })
    ).toEqual({
      deployment: ["toks4"],
      substrate: ["toks4"],
      offCluster: ["toks4"],
      providers: { toks4: "akash" },
      k3s: [],
      k3sNodes: [],
      sourceRepositories: { toks4: "cogni-dao/toks4" },
      sourceShas: { toks4: "0123456789abcdef0123456789abcdef01234567" },
    });
  });

  it("fails closed for a target absent from the reviewed catalog", () => {
    expect(() =>
      resolveDeploymentTargets({
        catalogRows: [],
        environment: "candidate-a",
        flightTargets: ["unreviewed"],
      })
    ).toThrow("Unknown flight target");
  });

  it("fails closed before placement resolution when a node is absent from the environment", () => {
    expect(() =>
      resolveDeploymentTargets({
        catalogRows: [
          {
            name: "poly",
            type: "node",
            envs: ["production"],
            source_repo: "https://github.com/cogni-dao/poly",
            source_sha: "0123456789abcdef0123456789abcdef01234567",
            deployment_provider: { production: "akash" },
          },
        ],
        environment: "candidate-a",
        flightTargets: ["poly"],
      })
    ).toThrow("Flight target poly is not configured for candidate-a");
  });
});

describe("resolvePromoteDeploymentTargets", () => {
  const catalogRows = [
    {
      name: "legacy",
      type: "node",
      envs: ["preview", "production"],
    },
    { name: "scheduler-worker", type: "service" },
    {
      name: "external",
      type: "node",
      envs: ["preview"],
      source_repo: "https://github.com/Cogni-DAO/external.git",
      source_sha: "0123456789abcdef0123456789abcdef01234567",
      deployment_provider: { preview: "akash" },
    },
  ];

  it("preserves the legacy k3s list and appends eligible off-cluster nodes", () => {
    expect(
      resolvePromoteDeploymentTargets({
        catalogRows,
        environment: "preview",
        requestedTargets: [],
        legacyK3sTargets: ["scheduler-worker", "legacy", "external"],
      })
    ).toEqual({
      deployment: ["scheduler-worker", "legacy", "external"],
      substrate: ["legacy", "external"],
      offCluster: ["external"],
      providers: {
        "scheduler-worker": "k3s",
        legacy: "k3s",
        external: "akash",
      },
      k3s: ["scheduler-worker", "legacy"],
      k3sNodes: ["legacy"],
      sourceRepositories: { external: "cogni-dao/external" },
      sourceShas: {
        external: "0123456789abcdef0123456789abcdef01234567",
      },
      // No preview-forward mode stated ⇒ every target false (bug.5195).
      previewForward: {
        "scheduler-worker": false,
        legacy: false,
        external: false,
      },
    });
  });

  it("resolves the reviewed catalog source_sha for a remote-source node still on k3s this env (bug: node-template prod promote, story.5016)", () => {
    const sourceSha = "654e5f2132cdc774a329f24c69340170e4721d2a";
    const mixedPlacementRows = [
      {
        name: "node-template",
        type: "node",
        envs: ["candidate-a", "preview", "production"],
        source_repo: "https://github.com/Cogni-DAO/node-template.git",
        source_sha: sourceSha,
        // Off-cluster (akash) only for candidate-a — production/preview
        // default to k3s (K3S_IS_DEFAULT) but are still remote-source.
        deployment_provider: { "candidate-a": "akash" },
      },
    ];

    const selection = resolvePromoteDeploymentTargets({
      catalogRows: mixedPlacementRows,
      environment: "production",
      requestedTargets: ["node-template"],
      legacyK3sTargets: ["node-template"],
    });

    expect(selection.offCluster).toEqual([]);
    expect(selection.providers).toEqual({ "node-template": "k3s" });
    // The bug: this map used to stay empty for a k3s-provider remote-source
    // node, starving resolve_remote_source_sha's "operator source_sha +
    // reviewed catalog source_sha" branch and hard-failing node-substrate.
    expect(selection.sourceShas).toEqual({ "node-template": sourceSha });
    expect(selection.sourceRepositories).toEqual({
      "node-template": "cogni-dao/node-template",
    });
  });

  it("projects the reviewed catalog pin for an operator-merge preview", () => {
    const sourceSha = "947c241ffa0cf0e31fb614b81e6837633f891e98";
    const selection = resolvePromoteDeploymentTargets({
      catalogRows: [
        {
          name: "toks4",
          type: "node",
          envs: ["preview"],
          source_repo: "https://github.com/Cogni-DAO/toks4.git",
          source_sha: sourceSha,
          deployment_provider: { preview: "akash" },
        },
      ],
      environment: "preview",
      requestedTargets: ["toks4"],
      legacyK3sTargets: [],
    });

    expect(selection.offCluster).toEqual(["toks4"]);
    expect(selection.sourceShas).toEqual({ toks4: sourceSha });
  });

  it("does not admit an off-cluster node outside the selected environment", () => {
    expect(
      resolvePromoteDeploymentTargets({
        catalogRows,
        environment: "production",
        requestedTargets: ["external"],
        legacyK3sTargets: [],
      }).deployment
    ).toEqual([]);
  });

  it("never changes a requested k3s target rejected by the legacy resolver", () => {
    expect(
      resolvePromoteDeploymentTargets({
        catalogRows,
        environment: "preview",
        requestedTargets: ["legacy"],
        legacyK3sTargets: [],
      }).deployment
    ).toEqual([]);
  });

  describe("preview-forward eligibility (bug.5195)", () => {
    // `envs:` is the selector, NOT the absence of a `source_sha` input. The real
    // promote that proved this: toks5 (`envs: [production]`) was dispatched with no
    // sourceSha — which is what the UI always sends — the run went preview-forward
    // for EVERY target, and `git fetch deploy/preview-toks5` exited 1 before
    // promote-k8s ran. The node never got its lease generation bump.
    const mixed = [
      {
        name: "prodonly",
        type: "node",
        envs: ["production"],
        source_repo: "https://github.com/Cogni-DAO/prodonly.git",
        source_sha: "0123456789abcdef0123456789abcdef01234567",
        deployment_provider: { production: "akash" },
      },
      {
        name: "bothenvs",
        type: "node",
        envs: ["preview", "production"],
        source_repo: "https://github.com/Cogni-DAO/bothenvs.git",
        source_sha: "89abcdef0123456789abcdef0123456789abcdef",
        deployment_provider: { production: "akash", preview: "akash" },
      },
    ];

    it("excludes a production-only node from preview-forward while the run is in that mode", () => {
      const selection = resolvePromoteDeploymentTargets({
        catalogRows: mixed,
        environment: "production",
        requestedTargets: ["prodonly"],
        legacyK3sTargets: [],
        previewForwardMode: true,
      });
      expect(selection.deployment).toContain("prodonly");
      expect(selection.previewForward.prodonly).toBe(false);
    });

    it("keeps preview-forward for a node the catalog still places in preview", () => {
      const selection = resolvePromoteDeploymentTargets({
        catalogRows: mixed,
        environment: "production",
        requestedTargets: ["bothenvs"],
        legacyK3sTargets: [],
        previewForwardMode: true,
      });
      expect(selection.previewForward.bothenvs).toBe(true);
    });

    it("decides per target, not per run", () => {
      const selection = resolvePromoteDeploymentTargets({
        catalogRows: mixed,
        environment: "production",
        requestedTargets: ["prodonly", "bothenvs"],
        legacyK3sTargets: [],
        previewForwardMode: true,
      });
      expect(selection.previewForward).toEqual({
        prodonly: false,
        bothenvs: true,
      });
    });

    it("is all-false when the run is not preview-forward at all", () => {
      const selection = resolvePromoteDeploymentTargets({
        catalogRows: mixed,
        environment: "production",
        requestedTargets: ["prodonly", "bothenvs"],
        legacyK3sTargets: [],
        previewForwardMode: false,
      });
      expect(selection.previewForward).toEqual({
        prodonly: false,
        bothenvs: false,
      });
    });

    it("defaults to off when the caller states no mode — a paid lane never opts in by omission", () => {
      const selection = resolvePromoteDeploymentTargets({
        catalogRows: mixed,
        environment: "production",
        requestedTargets: ["bothenvs"],
        legacyK3sTargets: [],
      });
      expect(selection.previewForward.bothenvs).toBe(false);
    });
  });
});
