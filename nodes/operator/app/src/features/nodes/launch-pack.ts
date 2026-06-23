// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/launch-pack`
 * Purpose: Build the minimal handoff packet a user's AI assistant needs after
 *   node publish. The wizard stores birth facts; live systems remain the source
 *   of truth for CI, GHCR, flight, and deployed build identity. The assistant is a
 *   read-only external dev: it forks the node repo to contribute, and every
 *   privileged action (run-checks, merge, flight) runs through the operator API
 *   gated by an owner-granted RBAC tuple — the lone human step.
 * Scope: Pure string/object construction. No IO.
 * Links: node-launch-handoff, api/v1/vcs/{run-checks,merge,flight} routes (#1792)
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
    "You are the AI developer taking this node from spawned scaffold to first deployed customization. You hold ZERO privileged GitHub access — you contribute as a read-only external dev, and every privileged action (releasing CI, merging, deploying) runs through the operator API on your behalf, authorized by an owner-granted RBAC tuple. The single human step in the whole path is the node owner approving that grant once.",
    "Your goal: fork the node repo, make a small style-kit customization PR, flight the PR-HEAD to Cogni operator candidate-a, validate it, then report the node-spawn scorecard + URLs to the human.",
    "",
    "The Cogni operator is the coordination service at the endpoint root above — use it for contributor registration, node developer-access requests, releasing your fork PR's checks, merging, and flight.",
    "A freshly-spawned node workspace ships with no `.env.cogni` and no Cogni credentials — expected, so do not hunt for a key file. Run /contribute-to-cogni against the operator endpoint root to register and mint your agent bearer token, then save it as `.env.cogni` at the repo root for future devs.",
    "With that token, recall the Cogni knowledge block above (it is auth-gated) and use `.claude/skills/node-wizard-scorecard/SKILL.md` when present — that skill is the authoritative runbook; the steps below are the kickstart.",
    "",
    "Required path:",
    "1. Fork the node repo to your own GitHub account and work from the fork — your clone of the Cogni-owned upstream is read-only, so a fork is your push target (`gh repo fork <node repo> --clone`, or `gh repo fork <node repo> --remote` if you are already inside an upstream clone). You never need write access to the upstream: you propose via a fork PR and the operator merges on your behalf.",
    `2. Fire the developer-access request IMMEDIATELY so the owner's approval runs in parallel with your styling work: POST ${OPERATOR_API_ROOT}/api/v1/nodes/${input.nodeId}/access-requests with your agent bearer token. The node owner approves it once in the node UI (Agents → Approve) — this is the ONE human gate. Your bearer can use the grant to run-checks / merge / flight, but can never approve itself.`,
    "3. Make the style-kit customization on a branch in your fork and open a PR against the upstream node repo. Do not push to upstream `main`, do not hand-edit the operator gitlink. Confirm the repo-spec keeps `knowledge.remote` (the Cogni-owned DoltHub mirror); do not add a DOLTHUB_REMOTE_URL env override.",
    `4. A fork PR's checks start held — release them through the operator: POST ${OPERATOR_API_ROOT}/api/v1/vcs/run-checks with your bearer and {nodeId, prNumber}. Let the node's own CI run and publish the child image; use the image tag CI reports as the deploy identity (live systems are the source of truth — do not assume the GHCR namespace).`,
    `5. Flight the PR-HEAD sha to candidate-a BEFORE merging (candidate validation must show the NEW styling, not the scaffold): POST ${OPERATOR_API_ROOT}/api/v1/vcs/flight with {nodeRef:{nodeId, sourceSha}}, once the image exists and your access is approved. Expect HTTP 202.`,
    "6. Verify the candidate `/version` buildSha matches the flighted PR-HEAD sha, screenshot the flighted UI (`.claude/skills/playwright-auth-bootstrap/SKILL.md`), run agent-first API validation, then present the scorecard to the human.",
    `7. Production path, after human sign-off: merge your child PR through the operator — POST ${OPERATOR_API_ROOT}/api/v1/vcs/merge with {nodeId, prNumber} (the operator App merges on green; branch protection on the node repo is the merge authority). Then merge the parent deployment-pin PR the same way ({prNumber} with no nodeId targets the operator monorepo). Ask the owner to revoke your grant when done — re-running flight then returns 403, proving teardown.`,
    "",
    "Use `.claude/skills/node-styling/SKILL.md` for the customization PR. If any step is blocked (access not approved, child image missing, parent pin disagrees, flight ineligible), report the exact blocked scorecard row instead of inventing a privileged manual step.",
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
