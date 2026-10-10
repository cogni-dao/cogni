// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/repo-spec`
 * Purpose: Pin TEMPLATE_SPEC_SHAPE — minting substitutes node identity into the exact inherited
 *   template spec, preserving review gates, schedules, private Workers, and future extensions.
 * Scope: Pure unit test over `renderRepoSpec` output; the adapter test owns the exact-fork-SHA read.
 * Invariants: minted spec has template-owned gates/workflows/deployment, has no `nodes:` registry
 *   (single-node-fork signal), and replaces only formation-owned identity/governance values.
 * Side-effects: none.
 * Links: src/shared/node-app-scaffold/gens/repo-spec, infra/catalog/node-template.yaml
 * @public
 */

import {
  COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS,
  extractNodeServices,
  hasDeclaredNodeDeployment,
  parseRepoSpec,
  resolveRuntimeProfileSecretRefs,
} from "@cogni/repo-spec";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { renderRepoSpec } from "./repo-spec";

const TEMPLATE_RULE_FILES = [
  "pr-syntropy-coherence.yaml",
  "patterns-and-docs.yaml",
  "repo-goal-alignment.yaml",
];

const TEMPLATE_REPO_SPEC = `# Template comment must survive specialization.
schema_version: "0.1.4"
node_id: "b927a9dd-6132-4fc9-a51e-e3cee2568e3c"
scope_id: "b44d4394-3147-5787-acab-51546be6a3da"
scope_key: default
intent:
  name: node-template
  hook: "Build from this shared foundation"
  mission: "Template mission"
  brand:
    icon: GitFork
    color: "#22c55e"
governance:
  chain_id: "8453"
activity_ledger:
  epoch_length_days: 7
  approvers:
    - "0x070075F1389Ae1182aBac722B36CA12285d0c949"
  activity_sources:
    github:
      attribution_pipeline: cogni-v0.0
      source_refs: ["Cogni-DAO/standalone-node"]
payments:
  status: pending_activation
payments_out:
  steward_wallet:
    address: "0x070075F1389Ae1182aBac722B36CA12285d0c949"
gates:
  - type: review-limits
    id: review_limits
    with:
      max_changed_files: 50
      max_total_diff_kb: 1500
  - type: ai-rule
    with:
      rule_file: pr-syntropy-coherence.yaml
  - type: ai-rule
    with:
      rule_file: patterns-and-docs.yaml
  - type: ai-rule
    with:
      rule_file: repo-goal-alignment.yaml
schedules:
  - id: node-template-daily-poem
    cron: "0 0 * * *"
    timezone: UTC
    workflow: ScheduledGraphWorkflow
    payload:
      graphId: "langgraph:poet"
deployment:
  services:
    - name: app
      artifact:
        name: app
        context: .
        dockerfile: Dockerfile
        target: runner
      port: 3200
      visibility: public
      runtime_profile: cogni-node-app-v1
      bindings: {}
      bind_host: 0.0.0.0
      resources:
        cpu_units: 2
        memory_mi: 2048
        storage_mi: 4096
    - name: workflow-worker
      artifact:
        name: workflow-worker
        context: .
        dockerfile: Dockerfile
        target: workflow-worker
      port: 9100
      visibility: private
      envs: [candidate-a]
      runtime_profile: cogni-workflow-worker-v1
      bindings: {}
      secret_refs:
        - key: SCHEDULER_API_TOKEN
      bind_host: 0.0.0.0
      resources:
        cpu_units: 1
        memory_mi: 1024
        storage_mi: 1024
template_extension:
  inherited: true
`;

const rendered = renderRepoSpec({
  templateRepoSpec: TEMPLATE_REPO_SPEC,
  slug: "my-node",
  repoOwner: "cogni-dao-test",
  nodeId: "11111111-2222-4333-8444-555555555555",
  chainId: 8453,
  daoContract: "0x1111111111111111111111111111111111111111",
  pluginContract: "0x2222222222222222222222222222222222222222",
  signalContract: "0x3333333333333333333333333333333333333333",
  tokenContract: "0x4444444444444444444444444444444444444444",
  knowledgeRemote: {
    database: "knowledge_my_node",
    owner: "cogni-dao-test",
    repo: "my-node",
    url: "https://doltremoteapi.dolthub.com/cogni-dao-test/my-node",
  },
});

interface ParsedGate {
  type: string;
  with?: { rule_file?: string };
}
interface ParsedSpec {
  node_id: string;
  intent?: {
    name: string;
    hook?: string;
    mission?: string;
    brand?: Record<string, unknown>;
  };
  activity_ledger?: {
    epoch_length_days: number;
    approvers: string[];
    activity_sources: {
      github?: {
        attribution_pipeline: string;
        source_refs: string[];
      };
    };
  };
  knowledge?: {
    database: string;
    remote: {
      provider: string;
      owner: string;
      repo: string;
      url: string;
      custody: string;
    };
  };
  payments: { status: string };
  distributions: { status: string };
  gates?: ParsedGate[];
  nodes?: unknown;
}

describe("renderRepoSpec — BORN_REVIEWABLE", () => {
  const spec = parseYaml(rendered) as ParsedSpec;
  const gates = spec.gates ?? [];

  it("is parseable identity + governance YAML", () => {
    expect(spec.node_id).toBe("11111111-2222-4333-8444-555555555555");
    expect(spec.intent?.name).toBe("my-node");
    expect(spec.payments.status).toBe("pending_activation");
    expect(spec.distributions.status).toBe("pending_activation");
  });

  it("emits a starter intent.mission seed for the launch agent to refine", () => {
    expect(spec.intent?.mission).toBeTruthy();
    expect(spec.intent?.mission).toContain("my-node");
  });

  it("does not leak node-template's tagline or brand into the new identity", () => {
    expect(spec.intent?.hook).toBeUndefined();
    expect(spec.intent?.brand).toBeUndefined();
  });

  it("honours an explicit mission when provided", () => {
    const withMission = parseYaml(
      renderRepoSpec({
        templateRepoSpec: TEMPLATE_REPO_SPEC,
        slug: "my-node",
        repoOwner: "cogni-dao-test",
        nodeId: "11111111-2222-4333-8444-555555555555",
        chainId: 8453,
        mission: "Mirror Polymarket copy-trades for the DAO.",
      })
    ) as ParsedSpec;
    expect(withMission.intent?.mission).toBe(
      "Mirror Polymarket copy-trades for the DAO."
    );
  });

  it("keeps the node-template activity ledger so epoch ingest is active", () => {
    expect(spec.activity_ledger).toMatchObject({
      epoch_length_days: 7,
      activity_sources: {
        github: {
          attribution_pipeline: "cogni-v0.0",
          source_refs: ["cogni-dao-test/my-node"],
        },
      },
    });
    expect(spec.activity_ledger?.approvers).toContain(
      "0x070075F1389Ae1182aBac722B36CA12285d0c949"
    );
  });

  it("emits the default review gates so minted nodes are born-reviewable", () => {
    const types = gates.map((g) => g.type);
    expect(types).toContain("review-limits");
    expect(types.filter((t) => t === "ai-rule").length).toBeGreaterThanOrEqual(
      1
    );
  });

  it("emits a parseable Cogni-owned DoltHub knowledge remote", () => {
    expect(() => parseRepoSpec(rendered)).not.toThrow();
    expect(spec.knowledge).toEqual({
      database: "knowledge_my_node",
      remote: {
        provider: "dolthub",
        owner: "cogni-dao-test",
        repo: "my-node",
        url: "https://doltremoteapi.dolthub.com/cogni-dao-test/my-node",
        custody: "cogni-owned",
      },
    });
  });

  it("has NO `nodes:` registry — resolves as a single-node fork", () => {
    expect(spec.nodes).toBeUndefined();
  });

  it("references the external node-template ai-rule set", () => {
    const ruleFiles = gates
      .filter((g) => g.type === "ai-rule")
      .map((g) => g.with?.rule_file)
      .filter((rf): rf is string => typeof rf === "string");
    expect(ruleFiles).toEqual(TEMPLATE_RULE_FILES);
  });
});

describe("renderRepoSpec — BORN_DEPLOYABLE", () => {
  const parsed = parseRepoSpec(rendered);
  const template = parseRepoSpec(TEMPLATE_REPO_SPEC);

  it("preserves the exact template deployment instead of rebuilding an app-only fallback", () => {
    expect(hasDeclaredNodeDeployment(parsed)).toBe(true);
    expect(parsed.deployment).toEqual(template.deployment);
  });

  it("declares exactly one public service with complete resources", () => {
    const services = extractNodeServices(parsed);
    expect(
      services.filter((service) => service.visibility === "public")
    ).toHaveLength(1);
    for (const service of services) {
      expect(service.resources.cpuUnits).toBeGreaterThan(0);
      expect(service.resources.memoryMi).toBeGreaterThan(0);
      expect(service.resources.storageMi).toBeGreaterThan(0);
    }
  });

  it("preserves the private workflow Worker and its candidate environment gate", () => {
    const worker = extractNodeServices(parsed).find(
      (service) => service.runtimeProfile === "cogni-workflow-worker-v1"
    );
    expect(worker).toMatchObject({
      name: "workflow-worker",
      visibility: "private",
      envs: ["candidate-a"],
    });
  });

  it("preserves the node-owned schedule that targets the inherited Worker", () => {
    expect(parsed.schedules).toEqual(template.schedules);
    expect(parsed.schedules).toMatchObject([
      {
        id: "node-template-daily-poem",
        workflow: "ScheduledGraphWorkflow",
        payload: { graphId: "langgraph:poet" },
      },
    ]);
  });

  it("preserves template extensions unknown to the operator renderer", () => {
    expect(
      (parsed as unknown as Record<string, unknown>).template_extension
    ).toEqual({ inherited: true });
    expect(rendered).toContain(
      "# Template comment must survive specialization."
    );
  });

  it("keeps app profile refs implicit and resolves the full contract at build time", () => {
    const [app] = extractNodeServices(parsed);
    expect(app?.runtimeProfile).toBe("cogni-node-app-v1");
    // The minted spec does not re-list the profile's keys (bug.5175 prune)...
    expect(app?.secretRefs).toEqual([]);
    // ...and the raw minted YAML never contains them either.
    expect(rendered).not.toContain("EVM_RPC_URL");
    // The profile supplies the complete contract when the workload is built.
    expect(
      resolveRuntimeProfileSecretRefs({
        runtimeProfile: app?.runtimeProfile,
        secretRefs: app?.secretRefs ?? [],
      }).map((ref) => ref.key)
    ).toEqual([...COGNI_NODE_APP_V1_REQUIRED_SECRET_KEYS]);
  });
});
