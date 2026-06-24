// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/features/nodes/launch-pack`
 * Purpose: Unit tests for the AI-assistant launch handoff packet.
 * Scope: Pure builder only.
 * Side-effects: none
 * Links: src/features/nodes/launch-pack.ts
 * @public
 */

import { describe, expect, it } from "vitest";

import { nodeLaunchPackOperation } from "@/contracts/nodes.launch-pack.v1.contract";
import {
  buildNodeLaunchPack,
  candidateUrlForSlug,
  NODE_LAUNCH_PACK_KNOWLEDGE_ID,
  nodeRepoUrlForSlug,
  ownerFromGithubPrUrl,
} from "@/features/nodes/launch-pack";

describe("candidateUrlForSlug", () => {
  it("uses the candidate-a node host convention", () => {
    expect(candidateUrlForSlug("atlas")).toBe(
      "https://atlas-test.cognidao.org"
    );
  });
});

describe("ownerFromGithubPrUrl", () => {
  it("extracts the GitHub owner from a PR URL", () => {
    expect(
      ownerFromGithubPrUrl("https://github.com/cogni-test-org/cogni/pull/1559")
    ).toBe("cogni-test-org");
  });

  it("returns null for absent, invalid, or non-GitHub URLs", () => {
    expect(ownerFromGithubPrUrl(null)).toBeNull();
    expect(ownerFromGithubPrUrl("not a url")).toBeNull();
    expect(
      ownerFromGithubPrUrl("https://gitlab.com/cogni-test-org/cogni/pull/1559")
    ).toBeNull();
  });
});

describe("nodeRepoUrlForSlug", () => {
  it("uses the configured mint owner when present", () => {
    expect(
      nodeRepoUrlForSlug({
        slug: "atlas",
        mintOwner: "cogni-nodes",
        publishPrUrl: "https://github.com/cogni-test-org/cogni/pull/1559",
      })
    ).toBe("https://github.com/cogni-nodes/atlas");
  });

  it("falls back to the parent PR owner when mint owner is absent", () => {
    expect(
      nodeRepoUrlForSlug({
        slug: "atlas",
        mintOwner: undefined,
        publishPrUrl: "https://github.com/cogni-test-org/cogni/pull/1559",
      })
    ).toBe("https://github.com/cogni-test-org/atlas");
  });

  it("returns null when no owner can be recovered", () => {
    expect(
      nodeRepoUrlForSlug({
        slug: "atlas",
        mintOwner: undefined,
        publishPrUrl: null,
      })
    ).toBeNull();
  });
});

describe("buildNodeLaunchPack", () => {
  it("returns prompt + JSON pointers for a published node", () => {
    const pack = buildNodeLaunchPack({
      nodeId: "11111111-1111-4111-8111-111111111111",
      slug: "atlas",
      status: "published",
      operatorOrigin: "https://test.cognidao.org/",
      nodeRepoUrl: "https://github.com/Cogni-DAO/atlas",
      knowledgeRepoUrl:
        "https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas",
      publishPrUrl: "https://github.com/Cogni-DAO/cogni/pull/42",
    });

    expect(pack.kind).toBe("cogni.node.launch_pack.v0");
    expect(pack.launchPackUrl).toBe(
      "https://test.cognidao.org/api/v1/nodes/11111111-1111-4111-8111-111111111111/launch-pack"
    );
    expect(() => nodeLaunchPackOperation.output.parse(pack)).not.toThrow();
    expect(pack.knowledgeBlock.id).toBe(NODE_LAUNCH_PACK_KNOWLEDGE_ID);
    expect(pack.knowledgeBlock.url).toBe(
      `https://cognidao.org/knowledge/${NODE_LAUNCH_PACK_KNOWLEDGE_ID}`
    );
    expect(pack.parentDeploymentPrUrl).toBe(
      "https://github.com/Cogni-DAO/cogni/pull/42"
    );
    expect(pack.nodeRepoUrl).toBe("https://github.com/Cogni-DAO/atlas");
    expect(pack.knowledgeRepoUrl).toBe(
      "https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas"
    );
    expect(pack.prompt).toContain("Launch Cogni node atlas.");
    expect(pack.prompt).toContain(
      "Node repo URL: https://github.com/Cogni-DAO/atlas"
    );
    expect(pack.prompt).not.toContain("Launch pack URL:");
    expect(pack.prompt).not.toContain(pack.launchPackUrl);
    expect(pack.prompt).toContain(
      "Cogni operator endpoint root: https://cognidao.org"
    );
    expect(pack.prompt).toContain(
      "Cogni knowledge block: https://cognidao.org/knowledge/node-launch-handoff"
    );
    expect(pack.prompt).toContain(
      "DoltHub knowledge repo: https://www.dolthub.com/repositories/cogni-dao/knowledge-atlas"
    );
    expect(pack.prompt).toContain("Parent deployment PR:");
    expect(pack.prompt).toContain("Candidate URL:");

    // Identity + goal: a ZERO-privilege external dev who requests branch-push for its own account.
    expect(pack.prompt).toContain(
      "You are the AI developer taking this node from spawned scaffold to first deployed customization."
    );
    expect(pack.prompt).toContain("ZERO privileged GitHub access");
    expect(pack.prompt).toContain("branch-push on the node repo");
    expect(pack.prompt).toContain("style-kit customization");
    expect(pack.prompt).toContain(
      ".claude/skills/node-wizard-scorecard/SKILL.md"
    );
    expect(pack.prompt).not.toContain("@node-wizard-scorecard");
    expect(pack.prompt).not.toContain("Its first response");

    expect(pack.prompt).toContain(".env.cogni");
    expect(pack.prompt).toContain("/contribute-to-cogni");
    expect(pack.prompt).toContain("recall the Cogni knowledge block above");
    // Register-before-recall is the whole point: a fresh node has no token, and
    // the knowledge block is auth-gated, so /contribute-to-cogni (mint token)
    // MUST come before "recall the Cogni knowledge block". Lock the ordering so
    // it cannot silently regress (the prior bug ordered recall first → 401 loop).
    expect(pack.prompt.indexOf("/contribute-to-cogni")).toBeLessThan(
      pack.prompt.indexOf("recall the Cogni knowledge block above")
    );

    // DELEGATION, not duplication: the prompt points at the reusable guides for
    // the ordered e2e procedure and must NOT hardcode the operator vcs routes —
    // that is exactly what drifted (run-checks → run-ci). Locking the absence of
    // those paths keeps the kickstart from re-growing a parallel runbook.
    expect(pack.prompt).toContain("cicd-e2e-required-sequence");
    expect(pack.prompt).toContain("node-launch-handoff");
    expect(pack.prompt).not.toContain("/api/v1/vcs/run-ci");
    expect(pack.prompt).not.toContain("/api/v1/vcs/run-checks");
    expect(pack.prompt).not.toContain("/api/v1/vcs/flight");
    expect(pack.prompt).not.toContain("/api/v1/vcs/merge");

    // Branch-push framing present, but the contribution FLOW is delegated to the guide — the launch
    // pack must NOT embed the fork mechanism (it points at cicd-e2e-required-sequence). Self-merge /
    // pr-manager-graph path stays purged.
    expect(pack.prompt).toContain("branch-push");
    expect(pack.prompt).not.toContain("fork the node repo");
    expect(pack.prompt).not.toContain("merge your own PR");
    expect(pack.prompt).not.toContain("ask the Cogni PR Manager graph");
    expect(pack.prompt).not.toContain('graph_name "pr-manager"');
    expect(pack.prompt).not.toContain("/api/v1/chat/completions");

    // Node-specific guardrails (the bits that ARE node-scoped, not generic CICD).
    expect(pack.prompt).toContain("knowledge.remote");
    expect(pack.prompt).toContain("do not add a DOLTHUB_REMOTE_URL");
    expect(pack.prompt).toContain("Do not push to `main`");

    // RBAC owner-approve is the lone human step, fired immediately (node-scoped
    // URL stays in the prompt because it interpolates THIS node's id).
    expect(pack.prompt).toContain("developer-access request");
    expect(pack.prompt).toContain(
      `/api/v1/nodes/11111111-1111-4111-8111-111111111111/access-requests`
    );
    expect(pack.prompt).toContain("the only human step");
    expect(pack.prompt).toContain("never self-approve");

    expect(pack.prompt).not.toContain("browser-session-flight-auth.md");
    expect(pack.prompt).not.toContain("node-app-secrets");
    expect(pack.prompt).not.toContain("OpenBao");
    expect(pack.prompt).toContain("operator API");

    expect(pack.prompt).toContain(".claude/skills/node-styling/SKILL.md");
    expect(pack.prompt).not.toContain("node-formation-styling-guide");
    expect(pack.prompt).toContain("agent-first validation");
    expect(pack.prompt).toContain("scorecard");
    expect(pack.prompt).toContain("blocked scorecard row");
    expect(pack.prompt).toContain("/version");
  });
});
