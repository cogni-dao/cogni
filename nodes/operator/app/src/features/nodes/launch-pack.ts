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

const KNOWLEDGE_TITLE = "AI assistant launch pack for node birth";
const KNOWLEDGE_BASE_URL = "https://cognidao.org";

export interface NodeLaunchPackInput {
  readonly nodeId: string;
  readonly slug: string;
  readonly status: NodeStatus;
  readonly operatorOrigin: string;
  readonly nodeRepoUrl: string | null;
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
    return url.pathname.split("/").filter(Boolean)[0] ?? null;
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

  const prompt = [
    `Launch Cogni node ${input.slug}.`,
    "",
    nodeRepoLine,
    `Cogni knowledge block: ${knowledgeUrl}`,
    parentPrLine,
    `Candidate URL: ${candidateUrl}`,
    "",
    "Start with @node-wizard-scorecard. Its first response is not a full matrix until the child customization PR exists.",
    "If this workspace lacks `.env.cogni`, run /contribute-to-cogni against the production operator first and save the file at the repo root. Then recall the Cogni knowledge block before editing.",
    "Required path:",
    "1. Create a node customization PR in the node repo. Do not push directly to main, merge your own PR, or hand-edit the operator gitlink.",
    "2. Verify the node repo-spec contains `knowledge.remote` for the Cogni-owned DoltHub mirror; do not add a DOLTHUB_REMOTE_URL env override.",
    "3. Let the node repo CI build normally after that PR merges; use the child repo `main` SHA and `ghcr.io/<owner>/<repo>:sha-<sourceSha>` as the deploy identity.",
    "4. Right before flighting, ensure the parent deployment PR is merged and the parent pin agrees with the image-producing child main SHA.",
    "5. Request candidate-a flight through the operator API only after the child image tag exists and the parent pin agrees.",
    "6. Verify the deployed /version at the candidate URL.",
    "7. Run agent-first API validation against that candidate.",
    "8. Present the human scorecard only after flight, /version, and agent-first validation are green.",
    "",
    "Use @node-formation-styling-guide for the customization PR. If parent merge, child image, parent pin, or flight eligibility is blocked, report the exact blocked scorecard row instead of inventing privileged manual steps.",
  ].join("\n");

  return {
    kind: "cogni.node.launch_pack.v0",
    nodeId: input.nodeId,
    slug: input.slug,
    status: input.status,
    operatorBaseUrl,
    launchPackUrl,
    nodeRepoUrl: input.nodeRepoUrl,
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
