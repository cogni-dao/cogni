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
    "Clone or fetch the node repo in this workspace.",
    `Recover the NODE git ref from the nodes/${input.slug} submodule gitlink in the parent PR, then check out that ref.`,
    "Use @node-formation-styling-guide.",
    "Make a node-formation styling PR for this node's niche.",
    "Follow /contribute-to-cogni: get CI green, flight candidate-a, and verify the deployed /version at the candidate URL.",
  ].join("\n");

  return {
    kind: "cogni.node.launch_pack.v0",
    nodeId: input.nodeId,
    slug: input.slug,
    status: input.status,
    operatorBaseUrl,
    launchPackUrl,
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
