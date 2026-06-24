// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/nodes/launch-pack`
 * Purpose: Build the minimal handoff packet a user's AI assistant needs after
 *   node publish. The wizard stores birth facts; live systems remain the source
 *   of truth for CI, GHCR, flight, and deployed build identity. The assistant
 *   starts with no privileged GitHub access: it DECLARES its GitHub login on the
 *   developer-access request, and the owner's single Approve provisions branch-push
 *   on the node repo for that login (rbac.md §6a) — so it pushes a branch to the
 *   node repo it was handed and opens a SAME-REPO PR (a personal fork-PR is only the
 *   fallback when no login was declared / push wasn't granted). Every privileged
 *   action (run-ci, merge, flight) runs through the operator API gated by the same
 *   owner-granted RBAC tuple — the lone human step.
 * Scope: Pure string/object construction. No IO.
 * Links: node-launch-handoff, api/v1/vcs/{run-ci,merge,flight} routes (#1792, #1801)
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
    "You are the AI developer taking this node from spawned scaffold to first deployed customization. You start with ZERO privileged GitHub access — you request developer access for your own GitHub account AND DECLARE YOUR GITHUB LOGIN in that request (the `githubLogin` field). The node owner approving that grant ONCE both gives THAT GitHub login branch-push on the node repo AND authorizes every privileged step (CI, build, flight, merge, promote) through the operator API on your behalf. That single Approve click is the only human step. (If you omit `githubLogin`, the grant is authority-only — you get no branch-push and must fall back to a personal fork PR.)",
    "Your goal: a small style-kit customization, taken end-to-end to a live, validated candidate-a deploy, then reported to the human.",
    "",
    "A freshly-spawned node workspace ships with no `.env.cogni` and no Cogni credentials — expected, so do not hunt for a key file. Run /contribute-to-cogni against the operator endpoint root to register and mint your agent bearer token, save it as `.env.cogni` at the repo root, then recall the Cogni knowledge block above (it is auth-gated).",
    "",
    "The exact end-to-end procedure lives in the reusable guides, NOT this prompt — follow them as the source of truth so this handoff can never drift from the live operator routes:",
    "- `cicd-e2e-required-sequence` — the required ordered steps and the operator API call for each (request access → branch-push → run-ci → flight → validate → merge → promote). The privileged steps (flight/merge/promote) are operator-bridged via your Bearer key, never personal `gh`.",
    "- `node-launch-handoff` (the knowledge block above) — the launch-specific runbook: the two agent accounts, firing the developer-access request FIRST so owner approval runs in parallel, flighting the PR-HEAD so candidate validation shows your change, screenshots, and the scorecard.",
    "- `.claude/skills/node-wizard-scorecard/SKILL.md` (execution scorecard) and `.claude/skills/node-styling/SKILL.md` (the customization), when present in your workspace.",
    "",
    `Node-specific guardrails for THIS node: fire the developer-access request immediately — POST ${OPERATOR_API_ROOT}/api/v1/nodes/${input.nodeId}/access-requests with your bearer AND \`{"githubLogin":"<your-github-username>"}\` in the body. Declaring \`githubLogin\` is REQUIRED for the owner's Approve to provision your branch-push (rbac.md §6a); omit it and the grant is authority-only — you must then fall back to a personal fork PR. Fire it first so the Approve surfaces early and runs in parallel with your customization; the owner approves once in the node UI and your bearer can use the grant but never self-approve. AFTER approval, contribute on the node repo you were handed (see "Node repo URL" above): clone it, push your branch to it, and open a SAME-REPO PR — do NOT fork to your own account (fork-PR is only the fallback if branch-push was not granted). Do not push to \`main\` or hand-edit the operator gitlink; keep the repo-spec knowledge.remote (do not add a DOLTHUB_REMOTE_URL override); present the scorecard only after flight + /version + agent-first validation are green. The full ordered procedure lives in \`cicd-e2e-required-sequence\` — follow that guide, do not reinvent it here. If a step is blocked, report the exact blocked scorecard row instead of inventing a privileged manual step.`,
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
