// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/ci-invariants/custodied-worker-routing`
 * Purpose: Reproduce a born-healthy lane whose actual custodian queue has no poller.
 * Scope: Pure route transactions, fake GitHub CAS and static workflow boundaries. Does not contact GitHub or a cluster.
 * Invariants: PROTECTED_MAIN_CUSTODY, ONE_FIELD_ONLY, NO_IMAGE_PROMOTION.
 * Side-effects: IO (reads workflow YAML)
 * Links: https://cognidao.org/knowledge/lane-queue-follows-custody, spike.5010
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import yaml from "yaml";
import {
  addCustodiedCandidateRoutes,
  approvedCandidateRoutes,
  publishCustodiedRoutes,
} from "../../scripts/ci/reconcile-custodied-worker-routing";

const uuid = "f66b260b-4633-41e2-8711-b7c1b8449cc1";
const desired = `toks5=https://toks5-test.cognidao.org,${uuid}=https://toks5-test.cognidao.org`;
const catalogs = [
  {
    type: "node",
    name: "toks5",
    node_id: uuid,
    envs: ["candidate-a" as const, "production" as const],
    deployment_provider: { "candidate-a": "akash" },
  },
];
const field = "TEMPORAL_CUSTODIED_NODE_ENDPOINTS";
function patch(map: Record<string, string>): string {
  return `# Existing deployed worker; do not refresh topology or image here.\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: scheduler-worker-config\ndata:\n  COGNI_NODE_ENDPOINTS: "toks5=https://toks5.cognidao.org"\n  ${field}: '${JSON.stringify(map)}'\n  TEMPORAL_ADDRESS: "temporal:7233"\n  TEMPORAL_NAMESPACE: "cogni-production"\n  IMAGE_DIGEST: "sha256:unchanged"\n  GIT_SHA: "unchanged-worker-source"\n`;
}
function mapOf(text: string): Record<string, string> {
  return JSON.parse(yaml.parse(text).data[field]);
}

describe("custodied candidate queue activation", () => {
  it("derives foreign custody from the fleet and protected catalog, keeping isolated fleets local", () => {
    expect(
      approvedCandidateRoutes(
        catalogs,
        "production",
        patch({ "cogni-candidate-a": desired })
      )
    ).toEqual({ controlEnv: "production", csv: desired });
    expect(
      approvedCandidateRoutes(
        catalogs,
        "candidate-a",
        "no foreign authority exists"
      )
    ).toBeUndefined();
    expect(
      approvedCandidateRoutes(
        [{ ...catalogs[0], envs: ["production"] }],
        "production",
        ""
      )
    ).toBeUndefined();
    expect(
      approvedCandidateRoutes(
        [{ ...catalogs[0], deployment_provider: { "candidate-a": "k3s" } }],
        "production",
        ""
      )
    ).toBeUndefined();
  });

  it("fails closed for wrong-custodian, extra-node and mismatched identity routes", () => {
    expect(() =>
      approvedCandidateRoutes(
        catalogs,
        "production",
        patch({ "cogni-preview": desired })
      )
    ).toThrow();
    expect(() =>
      approvedCandidateRoutes(
        catalogs,
        "production",
        patch({
          "cogni-candidate-a": `${desired},outsider=https://other.example`,
        })
      )
    ).toThrow(/unregistered/);
    expect(() =>
      approvedCandidateRoutes(
        catalogs,
        "production",
        patch({
          "cogni-candidate-a": `toks5=https://wrong.example,${uuid}=https://toks5-test.cognidao.org`,
        })
      )
    ).toThrow(/identities/);
  });

  it("adds the missing candidate pair while preserving every other byte and unrelated route", () => {
    const current = patch({
      "cogni-preview": "toks5=https://toks5-preview.cognidao.org",
      "cogni-candidate-a": "other=https://other-test.example",
    });
    const next = addCustodiedCandidateRoutes(current, desired);
    const omitField = (text: string) =>
      text.replace(/^ {2}TEMPORAL_CUSTODIED_NODE_ENDPOINTS:.*$/m, "");
    expect(omitField(next)).toBe(omitField(current));
    expect(mapOf(next)["cogni-preview"]).toBe(mapOf(current)["cogni-preview"]);
    expect(mapOf(next)["cogni-candidate-a"]).toBe(
      `other=https://other-test.example,${desired}`
    );
    expect(addCustodiedCandidateRoutes(next, desired)).toBe(next);
  });

  it("refuses existing alias collisions and credential-bearing URLs", () => {
    expect(() =>
      addCustodiedCandidateRoutes(
        patch({ "cogni-candidate-a": "toks5=https://different.example" }),
        desired
      )
    ).toThrow(/collision/);
    expect(() =>
      addCustodiedCandidateRoutes(
        patch({}),
        "toks5=https://secret:password@host.example"
      )
    ).toThrow(/credential-free/);
  });

  it("re-reads a concurrent file change and uses Contents CAS without replacing the deploy tree", async () => {
    const first = patch({ "cogni-preview": "preview=https://preview.example" });
    const raced = patch({
      "cogni-preview":
        "preview=https://preview.example,new=https://new.example",
    });
    let reads = 0;
    let puts = 0;
    const writes: Array<{ endpoint: string; body: Record<string, string> }> =
      [];
    const api = vi.fn(
      async (method: string, endpoint: string, body?: unknown) => {
        if (method === "GET" && endpoint.startsWith("git/ref/"))
          return { object: { sha: `tip-${++reads}` } };
        if (method === "GET")
          return {
            sha: `blob-${reads}`,
            content: Buffer.from(reads === 1 ? first : raced).toString(
              "base64"
            ),
            encoding: "base64",
          };
        writes.push({ endpoint, body: body as Record<string, string> });
        if (++puts === 1)
          throw Object.assign(new Error("concurrent writer"), { status: 409 });
        return { commit: { sha: "new-deploy-tip" } };
      }
    );
    await expect(
      publishCustodiedRoutes(api, "production", desired)
    ).resolves.toEqual({ changed: true, deploySha: "new-deploy-tip" });
    const last = writes.at(-1);
    expect(last?.endpoint).toBe(
      "contents/infra/k8s/overlays/production/scheduler-worker/node-endpoints.patch.yaml"
    );
    expect(last?.body.branch).toBe("deploy/production-scheduler-worker");
    expect(last?.body.sha).toBe("blob-2");
    const saved = Buffer.from(last?.body.content ?? "", "base64").toString();
    expect(mapOf(saved)["cogni-preview"]).toContain("new=https://new.example");
    expect(
      saved.replace(/^ {2}TEMPORAL_CUSTODIED_NODE_ENDPOINTS:.*$/m, "")
    ).toBe(raced.replace(/^ {2}TEMPORAL_CUSTODIED_NODE_ENDPOINTS:.*$/m, ""));
    expect(
      api.mock.calls.every(([method]) => method === "GET" || method === "PUT")
    ).toBe(true);
  });
});

describe("custodian routing workflow authority", () => {
  const workflow = yaml.parse(
    readFileSync(
      path.resolve(__dirname, "../../.github/workflows/candidate-flight.yml"),
      "utf8"
    )
  );
  it("uses workflow tooling and pinned protected-main input, sharing the real worker writer lock", () => {
    const plan = workflow.jobs["plan-custodied-worker-routing"];
    expect(
      plan.steps.find(
        (step: { name?: string }) =>
          step.name === "Checkout protected routing authority"
      ).with.ref
    ).toBe("main");
    expect(
      plan.steps.find(
        (step: { name?: string }) =>
          step.name === "Plan approved foreign custody"
      ).env.FLEET_CONTROL_ENV
    ).toBe("${{ vars.FLEET_CONTROL_ENV || 'production' }}");
    const job = workflow.jobs["reconcile-custodied-worker-routing"];
    expect(job.concurrency.group).toBe(
      "flight-${{ matrix.control_env }}-scheduler-worker"
    );
    expect(job.environment).toBe("${{ matrix.control_env }}");
    expect(
      job.steps.find(
        (step: { name?: string }) =>
          step.name === "Publish only approved custodied queue aliases"
      ).env.FLEET_CONTROL_ENV
    ).toBe("${{ vars.FLEET_CONTROL_ENV || 'production' }}");
    expect(
      job.steps.find(
        (step: { name?: string }) =>
          step.name === "Checkout pinned protected routing authority"
      ).with.ref
    ).toBe("${{ needs.plan-custodied-worker-routing.outputs.authority_sha }}");
    const commands = job.steps
      .map((step: { run?: string }) => step.run ?? "")
      .join("\n");
    expect(commands).not.toMatch(
      /kubectl|ssh|deploy-infra|promote-build|reconcile-scheduler-worker-routing\.sh/
    );
    expect(JSON.stringify(job)).not.toMatch(
      /VM_HOST|SSH_DEPLOY_KEY|ACTIONS_AUTOMATION_BOT_PAT|GH_REVIEW_APP_PRIVATE_KEY/
    );
  });
  it("fails the aggregate before its no-app-target shortcut and gates public verification", () => {
    const report = workflow.jobs["report-status"];
    const gate = report.steps.find(
      (step: { name?: string }) => step.name === "Decide aggregate state"
    ).run;
    expect(report.needs).toContain("reconcile-custodied-worker-routing");
    expect(gate.indexOf('if [ "$CUSTODY_PLAN_RESULT"')).toBeLessThan(
      gate.indexOf('elif [ "$HAS_FLIGHT_TARGETS"')
    );
    expect(workflow.jobs["verify-candidate"].if).toContain(
      "needs.reconcile-custodied-worker-routing.result == 'success'"
    );
  });
});
