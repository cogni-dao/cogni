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
 * Scope: Pure string/object construction with maintained knowledge pointers and separate
 *   node-local cognition and owning-operator credential instructions; explicit legacy and
 *   successor projections share the canonical prompt. No IO or key reads.
 * Invariants: STARTER_SHELVES_MIRROR_BASE_DOMAIN_SEEDS — `NODE_STARTER_SHELF_IDS`
 *   must equal the ids in `packages/knowledge-base/src/seeds/domains.ts`
 *   (`BASE_DOMAIN_SEEDS`), which is the source of truth. The operator app does not
 *   depend on `@cogni/knowledge-base` (a drizzle schema package), so the list is
 *   mirrored here as prompt text and pinned by `tests/meta/launch-pack-starter-shelves`.
 * Links: cicd-e2e-required-sequence, node-ai-traces-read, agent-evaluation-loop,
 *   agent-check-own-access, cogni-domain-taxonomy, task.5196, bug.5388, story.5117
 * @public
 */

import type { NodeLaunchPackOutput } from "@/contracts/nodes.launch-pack.v1.contract";
import type { NodeLaunchPackV2Output } from "@/contracts/nodes.launch-pack.v2.contract";
import type { NodeStatus } from "@/shared/db/nodes";

export const NODE_LAUNCH_PACK_KNOWLEDGE_ID = "node-launch-handoff";
export const NODE_LAUNCH_PACK_V2_KNOWLEDGE_ID = "cicd-e2e-required-sequence";

const KNOWLEDGE_TITLE = "AI assistant launch pack for node formation";
const KNOWLEDGE_V2_TITLE = "Ship a node change through the operator";
const KNOWLEDGE_BASE_URL = "https://cognidao.org";
const OPERATOR_API_ROOT = "https://cognidao.org";

/**
 * The starter shelves every spawned node registers on its OWN hub. Mirrors
 * `BASE_DOMAIN_SEEDS` (`packages/knowledge-base/src/seeds/domains.ts`), which
 * is the source of truth — a spawned node never runs the local-dev seeder, so
 * the first agent is the only thing that puts these rows in a node's registry.
 */
export const NODE_STARTER_SHELF_IDS = [
  "meta",
  "mission",
  "strategy",
  "method",
  "use-service",
  "build-agents",
  "build-product",
] as const;

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

function buildNodeLaunchPackBody(
  input: NodeLaunchPackInput
): Omit<NodeLaunchPackOutput, "kind" | "knowledgeBlock" | "launchPackUrl"> {
  const operatorBaseUrl = trimTrailingSlash(input.operatorOrigin);
  const knowledgeUrl = `${KNOWLEDGE_BASE_URL}/knowledge/${NODE_LAUNCH_PACK_V2_KNOWLEDGE_ID}`;
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
    "Credential bootstrap depends on how you opened this node repo:",
    "- Local Conductor workspace: let the committed setup finish. It auto-registers this node's `COGNI_NODE_API_KEY` when absent, saves it in the canonical primary checkout's `.env.cogni`, symlinks that file into this workspace, installs the stable user-level Codex cognition hook, and hydrates dependencies from cache or the network with one retry. Open `/hooks` once to trust that SessionStart hook; later local worktrees reuse the same trusted hook path.",
    "- Non-Conductor or manual clone: if `.env.cogni` has no `COGNI_NODE_API_KEY`, register at `POST <node-base-url>/api/v1/agent/register` on this node's own serving host and save the returned Bearer in `.env.cogni`. That credential is for node-local cognition and this node's hub.",
    "- Explicit operator actions and canonical guide reads use your own agent Bearer issued by the owning operator host, saved as `COGNI_OPERATOR_NODE_API_KEY`. Only when it is absent may `COGNI_OPERATOR_API_KEY` serve as a compatibility alias; when both exist the canonical variable wins. Register at that operator host if you have no saved operator credential. Verify `GET <operator-host>/api/v1/agent/me`; `grantsAvailable:false` means grants are unknown, and never try another key or host on 401/403. Follow the own-access guide below and request the normal owner-approved developer / node.flight grant. Keep node-local and operator credentials separate; use no Langfuse or Grafana keys or personal user cookies.",
    "",
    `Register this node's knowledge shelves BEFORE your first knowledge write. A spawned node's hub boots with no starter shelves, so every \`domain\` value has nowhere valid to point. Register these seven on THIS node's own hub — not the operator's — one \`POST <node-base-url>/api/v1/knowledge/domains\` per shelf with \`{"id":"<id>","name":"<Name>","description":"<one line>"}\` and your node bearer; 201 means registered:`,
    `  ${NODE_STARTER_SHELF_IDS.join(", ")}`,
    `\`use-*\` is the service surface THIS node offers outside consumers; \`build-*\` is the machinery that provides it — both relative to this hub, never to the operator's. Recall https://cognidao.org/knowledge/cogni-domain-taxonomy for the approved names, descriptions, and rationale, and copy them verbatim. The registry is APPEND-ONLY — POST exists, DELETE does not — so register exactly these seven starter IDs; a typo is permanent. Niche shelves follow that taxonomy and are registered on this node's hub; \`.cogni/repo-spec.yaml\` does not declare knowledge shelves. Never register the operator platform's internal shelves here. Each environment has its own \`knowledge_<slug>\` database, so registration is per-env: do it on the Candidate URL while you validate, and repeat it against the node's production host after promotion.`,
    "",
    "The exact end-to-end procedure lives in the reusable guides, NOT this prompt — follow them as the source of truth so this handoff can never drift from the live operator routes:",
    "- `cicd-e2e-required-sequence` — the required ordered steps and the operator API call for each (request access → branch-push → run-ci → fresh independent review while CI runs → flight → validate → closeout merge → promote). The privileged steps (flight/merge/promote) are operator-bridged via your Bearer key, never personal `gh`.",
    "- https://cognidao.org/knowledge/agent-check-own-access — verify your own principal, credential expiry and node grants at the owning operator host before protected actions.",
    "- https://cognidao.org/knowledge/node-ai-traces-read — discover the owning trace gateway, then read this node's attributed native AI observations with your own operator-issued credential and grant.",
    "- https://cognidao.org/knowledge/agent-evaluation-loop — refine an agent from trace evidence; trace access does not grant evaluator, dataset or score writes.",
    "- https://cognidao.org/knowledge/langfuse-eval-expert — engineer or diagnose attribution, custody and native trace contracts.",
    "- Use the CI/CD knowledge block above for launch execution and proof. Use `.claude/skills/node-styling/SKILL.md` for the customization when present in your workspace.",
    "",
    `Node-specific guardrails for THIS node: fire the developer-access request immediately — POST ${OPERATOR_API_ROOT}/api/v1/nodes/${input.nodeId}/access-requests with your operator-issued bearer AND \`{"role":"developer","githubLogin":"<your-github-username>"}\` in the body. Declaring \`githubLogin\` is REQUIRED for the owner's Approve to provision your branch-push (rbac.md §6a); omit it and the grant is authority-only — you must then fall back to a personal fork PR. Fire it first so the Approve surfaces early and runs in parallel with your customization; the owner approves once in the node UI and your bearer can use the grant but never self-approve. AFTER approval, contribute on the node repo you were handed (see "Node repo URL" above): clone it, push your branch to it, and open a SAME-REPO PR — do NOT fork to your own account (fork-PR is only the fallback if branch-push was not granted). Do not push to \`main\` or hand-edit the operator gitlink; keep the repo-spec knowledge.remote (do not add a DOLTHUB_REMOTE_URL override); present the scorecard only after flight + /version + agent-first validation are green. The full ordered procedure lives in \`cicd-e2e-required-sequence\` — follow that guide, do not reinvent it here. If a step is blocked, report the exact blocked scorecard row instead of inventing a privileged manual step.`,
  ].join("\n");

  return {
    nodeId: input.nodeId,
    slug: input.slug,
    status: input.status,
    operatorBaseUrl,
    nodeRepoUrl: input.nodeRepoUrl,
    knowledgeRepoUrl: input.knowledgeRepoUrl,
    parentDeploymentPrUrl: input.publishPrUrl,
    candidateUrl,
    prompt,
  };
}

export function buildNodeLaunchPack(
  input: NodeLaunchPackInput
): NodeLaunchPackOutput {
  const body = buildNodeLaunchPackBody(input);
  return {
    ...body,
    kind: "cogni.node.launch_pack.v0",
    launchPackUrl: `${body.operatorBaseUrl}/api/v1/nodes/${input.nodeId}/launch-pack`,
    knowledgeBlock: {
      id: NODE_LAUNCH_PACK_KNOWLEDGE_ID,
      title: KNOWLEDGE_TITLE,
      url: `${KNOWLEDGE_BASE_URL}/knowledge/${NODE_LAUNCH_PACK_KNOWLEDGE_ID}`,
    },
  };
}

export function buildNodeLaunchPackV2(
  input: NodeLaunchPackInput
): NodeLaunchPackV2Output {
  const body = buildNodeLaunchPackBody(input);
  return {
    ...body,
    kind: "cogni.node.launch_pack.v1",
    launchPackUrl: `${body.operatorBaseUrl}/api/v1/nodes/${input.nodeId}/launch-pack/v2`,
    knowledgeBlock: {
      id: NODE_LAUNCH_PACK_V2_KNOWLEDGE_ID,
      title: KNOWLEDGE_V2_TITLE,
      url: `${KNOWLEDGE_BASE_URL}/knowledge/${NODE_LAUNCH_PACK_V2_KNOWLEDGE_ID}`,
    },
  };
}
