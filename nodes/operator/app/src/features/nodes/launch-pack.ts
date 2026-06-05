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

import type { NodeStatus } from "@/shared/db/nodes";

export const NODE_LAUNCH_PACK_KNOWLEDGE_ID = "node-launch-handoff";

const KNOWLEDGE_TITLE = "AI assistant launch pack for node birth";
const KNOWLEDGE_BASE_URL = "https://cognidao.org";

export interface NodeLaunchPackInput {
  readonly nodeId: string;
  readonly slug: string;
  readonly status: NodeStatus;
  readonly operatorOrigin: string;
  readonly publishPrUrl: string | null;
}

export interface NodeLaunchPack {
  readonly kind: "cogni.node.launch_pack.v0";
  readonly nodeId: string;
  readonly slug: string;
  readonly status: NodeStatus;
  readonly operatorBaseUrl: string;
  readonly launchPackUrl: string;
  readonly parentDeploymentPrUrl: string | null;
  readonly candidateUrl: string;
  readonly knowledgeBlock: {
    readonly id: typeof NODE_LAUNCH_PACK_KNOWLEDGE_ID;
    readonly title: typeof KNOWLEDGE_TITLE;
    readonly url: string;
  };
  readonly prompt: string;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function candidateUrlForSlug(slug: string): string {
  return `https://${slug}-test.cognidao.org`;
}

export function buildNodeLaunchPack(
  input: NodeLaunchPackInput
): NodeLaunchPack {
  const operatorBaseUrl = trimTrailingSlash(input.operatorOrigin);
  const launchPackUrl = `${operatorBaseUrl}/api/v1/nodes/${input.nodeId}/launch-pack`;
  const knowledgeUrl = `${KNOWLEDGE_BASE_URL}/knowledge/${NODE_LAUNCH_PACK_KNOWLEDGE_ID}`;
  const candidateUrl = candidateUrlForSlug(input.slug);
  const parentPrLine = input.publishPrUrl
    ? `Parent deployment PR: ${input.publishPrUrl}`
    : "Parent deployment PR: not published yet";

  const prompt = [
    `Please launch Cogni node ${input.slug} end-to-end.`,
    "",
    `Launch pack: ${launchPackUrl}`,
    `Operator guide: ${knowledgeUrl}`,
    parentPrLine,
    `Candidate URL: ${candidateUrl}`,
    "",
    "Drive the launch from live systems: inspect the parent birth PR, recover the child repo/SHA/image from its gitlink and catalog row, wait for child image CI, request candidate flight through the operator when the parent PR is green, and report the live URL only after /version.buildSha matches the child SHA. Ask me only for auth or product-decision blockers.",
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
