// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/launch-pack`
 * Purpose: Build the minimal handoff packet a user's AI assistant needs after
 *   node publish. The wizard stores birth facts; live systems remain the source
 *   of truth for CI, GHCR, flight, and deployed build identity.
 * Scope: Pure string/object construction. No IO.
 * Links: node-launch-handoff
 * @public
 */

import type { NodeLaunchPackOutput } from "@/contracts/nodes.launch-pack.v1.contract";
import type { NodeStatus } from "@/shared/db/nodes";

export const NODE_LAUNCH_PACK_KNOWLEDGE_ID = "node-launch-handoff";

const KNOWLEDGE_TITLE = "AI assistant launch pack for node formation";
const KNOWLEDGE_BASE_URL = "https://cognidao.org";
const OPERATOR_API_ROOT = "https://cognidao.org";

export interface NodeLaunchPackInput {
  readonly nodeId: string;
  readonly slug: string;
  readonly status: NodeStatus;
  readonly operatorOrigin: string;
  readonly nodeRepoUrl: string | null;
  readonly knowledgeRepoUrl: string | null;
  readonly publishPrUrl: string | null;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function ownerFromGithubPrUrl(value: string | null): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.hostname !== "github.com") {
      return null;
    }
    return url.pathname.split("/").find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export function nodeRepoUrlForSlug(input: {
  readonly slug: string;
  readonly mintOwner: string | undefined;
  readonly publishPrUrl: string | null;
}): string | null {
  const owner = input.mintOwner ?? ownerFromGithubPrUrl(input.publishPrUrl);
  return owner ? `https://github.com/${owner}/${input.slug}` : null;
}

export function candidateUrlForSlug(slug: string): string {
  return `https://${slug}-test.cognidao.org`;
}

export function buildNodeLaunchPack(
  input: NodeLaunchPackInput
): NodeLaunchPackOutput {
  const operatorBaseUrl = trimTrailingSlash(input.operatorOrigin);
  const launchPackUrl = `${operatorBaseUrl}/api/v1/nodes/${input.nodeId}/launch-pack`;
  const knowledgeUrl = `${KNOWLEDGE_BASE_URL}/knowledge/${NODE_LAUNCH_PACK_KNOWLEDGE_ID}`;
  const candidateUrl = candidateUrlForSlug(input.slug);
  const nodeRepoLine = input.nodeRepoUrl
    ? `Node repo URL: ${input.nodeRepoUrl}`
    : "Node repo URL: recover it from the parent deployment PR submodule URL";
  const parentPrLine = input.publishPrUrl
    ? `Parent deployment PR: ${input.publishPrUrl}`
    : "Parent deployment PR: not published yet";
  const knowledgeRepoLine = input.knowledgeRepoUrl
    ? `DoltHub knowledge repo: ${input.knowledgeRepoUrl}`
    : "DoltHub knowledge repo: recover it from the node repo-spec `knowledge.remote` block";

  const prompt = [
    `Launch Cogni node ${input.slug}.`,
    "",
    nodeRepoLine,
    `Cogni operator endpoint root: ${OPERATOR_API_ROOT}`,
    `Cogni knowledge block: ${knowledgeUrl}`,
    knowledgeRepoLine,
    parentPrLine,
    `Candidate URL: ${candidateUrl}`,
    "",
    "You are the AI developer taking this node from spawned scaffold to first deployed customization.",
    "Your goal is to make a simple node style-kit customization, open a PR in the node repo, get that PR deployed to Cogni operator candidate-a via a flight, then report the node spawn scorecard/status and any useful URLs to the human.",
    "",
    "The Cogni operator is the coordination service at the endpoint root above. Use it for contributor registration, requesting node developer access, and candidate-a flight requests.",
    "Before editing, recall the Cogni knowledge block above and use `.claude/skills/node-wizard-scorecard/SKILL.md` when that skill exists in your workspace.",
    "If this workspace lacks `.env.cogni`, run /contribute-to-cogni against the production operator endpoint root first and save the file at the repo root.",
    "",
    "Required path:",
    "1. Create a node customization PR in the node repo. Do not push directly to main, merge your own PR, or hand-edit the operator gitlink.",
    "2. Verify the node repo-spec contains `knowledge.remote` for the Cogni-owned DoltHub mirror; do not add a DOLTHUB_REMOTE_URL env override.",
    "3. Let the node repo CI build normally after that PR merges; use the child repo `main` SHA and `ghcr.io/<owner>/<repo>:sha-<sourceSha>` as the deploy identity.",
    "4. Right before flighting, ensure the parent deployment PR is merged and the parent pin agrees with the image-producing child main SHA.",
    `5. Register as a contributor, then request developer access for this node: POST ${OPERATOR_API_ROOT}/api/v1/nodes/${input.nodeId}/access-requests with your agent bearer token. Then wait — the node owner approves your request in the node UI before any flight will pass node.flight.`,
    "6. Checkpoint with the human: give a brief status, progress, and next-steps summary; then follow the Cogni knowledge block above for bearer-token nodeRef flight and cleanup/revoke steps once approved.",
    "7. Request candidate-a flight through the operator API only after the child image tag exists, the parent pin agrees, and your developer access is approved.",
    "8. Verify the deployed /version at the candidate URL.",
    "9. Run agent-first API validation against that candidate.",
    "10. Present the human scorecard only after flight, /version, and agent-first validation are green.",
    "",
    "Use `.claude/skills/node-styling/SKILL.md` for the customization PR. To screenshot your customization on the flighted candidate URL, use `.claude/skills/playwright-auth-bootstrap/SKILL.md` to bootstrap an authed Playwright session against the test env. If parent merge, child image, parent pin, or flight eligibility is blocked, report the exact blocked scorecard row instead of inventing privileged manual steps.",
  ].join("\n");

  return {
    kind: "cogni.node.launch_pack.v0",
    nodeId: input.nodeId,
    slug: input.slug,
    status: input.status,
    operatorBaseUrl,
    launchPackUrl,
    nodeRepoUrl: input.nodeRepoUrl,
    knowledgeRepoUrl: input.knowledgeRepoUrl,
    parentDeploymentPrUrl: input.publishPrUrl,
    candidateUrl,
    knowledgeBlock: {
      id: NODE_LAUNCH_PACK_KNOWLEDGE_ID,
      title: KNOWLEDGE_TITLE,
      url: knowledgeUrl,
    },
    prompt,
  };
}
