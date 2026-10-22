// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  isInfraOnlyPromoteNoop,
  resolveDeploymentTargets,
  resolvePromoteDeploymentTargets,
} from "./node-deployment-targets";

// GitHub reports the running repository with its owner's display case; the
// resolver normalizes it exactly like catalog `source_repo`.
const PARENT_REPOSITORY = "Cogni-DAO/cogni";
const PARENT = "cogni-dao/cogni";

describe("resolveDeploymentTargets", () => {
  it("supplies the unchanged floor callers with a valid parent PR identity", () => {
    const root = path.resolve(import.meta.dirname, "../../../../../..");
    const head = "b00e4101a24fad3d18e93d9a6c76ec65e776266d";
    const selection = resolveDeploymentTargets({
      catalogRows: [{ name: "operator", type: "node", envs: ["candidate-a"] }],
      environment: "candidate-a",
      parentRepository: PARENT_REPOSITORY,
      parentSourceSha: head,
      flightTargets: ["operator"],
    });
    type Step = { name?: string; run?: string; env?: Record<string, string> };
    const workflow = parse(
      readFileSync(
        path.join(root, ".github/workflows/candidate-flight.yml"),
        "utf8"
      )
    ) as { jobs: Record<string, { steps: Step[] }> };
    const select = workflow.jobs.decide?.steps.find(
      (step) => step.name === "Select deployment targets by provider"
    );
    expect(select?.env?.PARENT_SOURCE_SHA).toBe(
      ["$", "{{ steps.meta.outputs.head_sha }}"].join("")
    );
    expect(select?.run).toContain('--source-sha "$PARENT_SOURCE_SHA"');
    const callers = Object.values(workflow.jobs)
      .flatMap((job) => job.steps)
      .filter(
        (step) =>
          step.run?.includes("maintenance-fence.py check") &&
          step.env?.SOURCE_REPOSITORY
      );
    expect(callers).toHaveLength(3);
    for (const caller of callers) {
      expect(caller.env?.SOURCE_SHA).toBe(
        [
          "$",
          "{{ needs.decide.outputs.node_source_sha || fromJSON(needs.decide.outputs.source_sha_by_target_json)[matrix.node] }}",
        ].join("")
      );
    }
    const result = execFileSync(
      "python3",
      [
        "-c",
        `
import json, runpy, sys
scope = runpy.run_path(sys.argv[1])
check = scope['check']
receipt = {'version': 1, 'phase': 'audited', 'operationId': 'a' * 64,
    'request': {'sourceRepository': 'cogni-dao/cogni',
                'sourceSha': '3e8ebeab9ce76be7bf5429ba23cee01062c2c7a2'}}
check.__globals__['read_present'] = lambda root, name: receipt if name == scope['RECEIPT'] else None
identity = json.load(sys.stdin)
calls = []
def compare(repo, base, head):
    calls.append([repo, base, head])
    return 'ahead' if head in ('main', identity['sha']) else 'behind'
check('.', identity['repo'], identity['sha'], compare)
assert calls[-1][2] == identity['sha']
for sha in ('', 'invalid', '0' * 40):
    try:
        check('.', identity['repo'], sha, compare)
    except RuntimeError as error:
        assert str(error) in ('maintenance_compatibility_floor_invalid', 'maintenance_compatibility_floor_violation')
    else:
        raise AssertionError('unsafe floor identity accepted')
print('valid-parent-accepted; missing-invalid-older-refused')
`,
        path.join(root, "scripts/ci/lib/maintenance-fence.py"),
      ],
      {
        input: JSON.stringify({
          repo: selection.sourceRepositories.operator,
          sha: selection.sourceShas.operator,
        }),
        encoding: "utf8",
      }
    );
    expect(result.trim()).toBe(
      "valid-parent-accepted; missing-invalid-older-refused"
    );
  });

  it("binds a reviewed parent PR head to only the selected in-repo node", () => {
    const head = "b00e4101a24fad3d18e93d9a6c76ec65e776266d";
    const result = resolveDeploymentTargets({
      catalogRows: [
        { name: "operator", type: "node", envs: ["candidate-a"] },
        { name: "sibling", type: "node", envs: ["candidate-a"] },
        { name: "scheduler-worker", type: "service" },
      ],
      environment: "candidate-a",
      parentRepository: PARENT_REPOSITORY,
      parentSourceSha: head,
      flightTargets: ["operator", "scheduler-worker"],
    });
    expect(result.sourceRepositories).toEqual({ operator: PARENT });
    expect(result.sourceShas).toEqual({ operator: head });
    expect(result.deployment).toEqual(["operator"]);
  });

  it("keeps an external catalog SHA separate from the reviewed parent head", () => {
    const child = "0123456789abcdef0123456789abcdef01234567";
    const result = resolveDeploymentTargets({
      catalogRows: [
        { name: "operator", type: "node", envs: ["candidate-a"] },
        {
          name: "remote",
          type: "node",
          envs: ["candidate-a"],
          source_repo: "https://github.com/cogni-dao/remote",
          source_sha: child,
          deployment_provider: { "candidate-a": "akash" },
        },
        {
          name: "explicit-parent",
          type: "node",
          envs: ["candidate-a"],
          source_repo: "https://github.com/cogni-dao/cogni",
        },
      ],
      environment: "candidate-a",
      parentRepository: PARENT_REPOSITORY,
      parentSourceSha: "a".repeat(40),
      flightTargets: ["operator", "remote", "explicit-parent"],
    });
    expect(result.sourceShas).toEqual({
      operator: "a".repeat(40),
      remote: child,
    });
    expect(result.sourceShas["explicit-parent"]).toBeUndefined();
  });

  it("refuses an invalid supplied parent SHA and never repairs a missing external SHA with it", () => {
    const input = {
      catalogRows: [{ name: "operator", type: "node", envs: ["candidate-a"] }],
      environment: "candidate-a" as const,
      parentRepository: PARENT_REPOSITORY,
      flightTargets: ["operator"],
    };
    for (const parentSourceSha of [
      "",
      "main",
      "a".repeat(39),
      "g".repeat(40),
    ]) {
      expect(() =>
        resolveDeploymentTargets({ ...input, parentSourceSha })
      ).toThrow(/parentSourceSha/);
    }
    expect(() =>
      resolveDeploymentTargets({
        ...input,
        parentSourceSha: "a".repeat(40),
        flightTargets: ["remote"],
        catalogRows: [
          {
            name: "remote",
            type: "node",
            envs: ["candidate-a"],
            source_repo: "https://github.com/cogni-dao/remote",
            deployment_provider: { "candidate-a": "akash" },
          },
        ],
      })
    ).toThrow(/source_sha/);
  });

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
        parentRepository: PARENT_REPOSITORY,
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
      sourceRepositories: { "node-template": PARENT, toks4: "cogni-dao/toks4" },
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
        parentRepository: PARENT_REPOSITORY,
        flightTargets: ["operator"],
      })
    ).toEqual({
      deployment: ["operator"],
      substrate: ["operator"],
      offCluster: [],
      providers: { operator: "k3s" },
      k3s: ["operator"],
      k3sNodes: ["operator"],
      sourceRepositories: { operator: PARENT },
      sourceShas: {},
    });
    expect(
      resolveDeploymentTargets({
        catalogRows,
        environment: "candidate-a",
        parentRepository: PARENT_REPOSITORY,
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

  // bug.5510: an in-repo self-flight used to emit no repository, so the
  // deploy-branch maintenance fence received SOURCE_REPOSITORY="" and refused
  // every operator flight once an audited receipt existed.
  it("gives every in-repo and remote k3s node target a source repository (bug.5510)", () => {
    const selection = resolveDeploymentTargets({
      catalogRows: [
        { name: "operator", type: "node", envs: ["candidate-a"] },
        {
          name: "beacon",
          type: "node",
          envs: ["candidate-a"],
          source_repo: "https://github.com/cogni-dao/beacon.git",
        },
        { name: "scheduler-worker", type: "service" },
      ],
      environment: "candidate-a",
      parentRepository: PARENT_REPOSITORY,
      flightTargets: ["operator", "beacon", "scheduler-worker"],
    });

    expect(selection.sourceRepositories).toEqual({
      operator: PARENT,
      beacon: "cogni-dao/beacon",
    });
    // No catalog pin exists for an in-repo node; its SHA is the flight's node-ref.
    expect(selection.sourceShas).toEqual({});
  });

  it.each([
    "",
    "cogni",
    "cogni-dao/cogni/extra",
    "https://github.com/cogni-dao/cogni",
    "../..",
    "./cogni",
    "cogni-dao/..",
  ])("fails closed on parent repository %j instead of emitting an empty identity", (parentRepository) => {
    expect(() =>
      resolveDeploymentTargets({
        catalogRows: [
          { name: "operator", type: "node", envs: ["candidate-a"] },
        ],
        environment: "candidate-a",
        parentRepository,
        flightTargets: ["operator"],
      })
    ).toThrow("parentRepository must be a GitHub owner/name");
  });

  it.each([
    "git@github.com:cogni-dao/beacon.git",
    "https://github.com/cogni-dao/..",
    "https://github.com/../beacon.git",
  ])("refuses malformed catalog source_repo %j rather than substituting the parent", (sourceRepo) => {
    expect(() =>
      resolveDeploymentTargets({
        catalogRows: [
          {
            name: "beacon",
            type: "node",
            envs: ["candidate-a"],
            source_repo: sourceRepo,
          },
        ],
        environment: "candidate-a",
        parentRepository: PARENT_REPOSITORY,
        flightTargets: ["beacon"],
      })
    ).toThrow("Target beacon has invalid source_repo");
  });

  it("fails closed for a target absent from the reviewed catalog", () => {
    expect(() =>
      resolveDeploymentTargets({
        catalogRows: [],
        environment: "candidate-a",
        parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
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
      sourceRepositories: { legacy: PARENT, external: "cogni-dao/external" },
      sourceShas: {
        external: "0123456789abcdef0123456789abcdef01234567",
      },
      infra: [],
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
      parentRepository: PARENT_REPOSITORY,
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

  it("gives an in-repo promote target the parent repository (bug.5510)", () => {
    const selection = resolvePromoteDeploymentTargets({
      catalogRows: [{ name: "operator", type: "node", envs: ["preview"] }],
      environment: "preview",
      parentRepository: PARENT_REPOSITORY,
      requestedTargets: ["operator"],
      legacyK3sTargets: ["operator"],
    });

    expect(selection.deployment).toEqual(["operator"]);
    expect(selection.sourceRepositories).toEqual({ operator: PARENT });
    expect(selection.sourceShas).toEqual({});
  });

  it("fails closed on an empty promote parent repository (bug.5510)", () => {
    expect(() =>
      resolvePromoteDeploymentTargets({
        catalogRows: [{ name: "operator", type: "node", envs: ["preview"] }],
        environment: "preview",
        parentRepository: "",
        requestedTargets: ["operator"],
        legacyK3sTargets: ["operator"],
      })
    ).toThrow("parentRepository must be a GitHub owner/name");
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
      parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
        requestedTargets: ["external"],
        legacyK3sTargets: [],
      }).deployment
    ).toEqual([]);
  });

  it("classifies catalog infra artifacts outside the app deployment lane", () => {
    const selection = resolvePromoteDeploymentTargets({
      catalogRows: [
        { name: "litellm", type: "infra" },
        { name: "openfga", type: "infra" },
      ],
      environment: "preview",
      parentRepository: PARENT_REPOSITORY,
      requestedTargets: ["litellm", "openfga"],
      legacyK3sTargets: [],
    });

    expect(selection.deployment).toEqual([]);
    expect(selection.infra).toEqual(["litellm", "openfga"]);
    expect(
      isInfraOnlyPromoteNoop({
        requestedTargets: ["litellm", "openfga"],
        selection,
      })
    ).toBe(true);
  });

  it("does not classify an unavailable node as an infra-only no-op", () => {
    const requestedTargets = ["external"];
    const selection = resolvePromoteDeploymentTargets({
      catalogRows,
      environment: "production",
      parentRepository: PARENT_REPOSITORY,
      requestedTargets,
      legacyK3sTargets: [],
    });

    expect(selection.deployment).toEqual([]);
    expect(isInfraOnlyPromoteNoop({ requestedTargets, selection })).toBe(false);
  });

  it("still fails closed for an unknown requested target", () => {
    expect(() =>
      resolvePromoteDeploymentTargets({
        catalogRows,
        environment: "preview",
        parentRepository: PARENT_REPOSITORY,
        requestedTargets: ["not-in-catalog"],
        legacyK3sTargets: [],
      })
    ).toThrow("Unknown promote target: not-in-catalog");
  });

  it("never changes a requested k3s target rejected by the legacy resolver", () => {
    expect(
      resolvePromoteDeploymentTargets({
        catalogRows,
        environment: "preview",
        parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
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
        parentRepository: PARENT_REPOSITORY,
        requestedTargets: ["bothenvs"],
        legacyK3sTargets: [],
      });
      expect(selection.previewForward.bothenvs).toBe(false);
    });
  });
});
