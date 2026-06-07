// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/repo-spec`
 * Purpose: Render a new node's `.cogni/repo-spec.yaml` — the web3-anchored identity + governance
 *   doc — so the operator can author a node-birth PR carrying the node's own identity instead of
 *   cloning the template's.
 * Scope: Pure transformer over server-verified DAO addresses + identity. `scope_id` is derived from
 *   `node_id` (uuidv5), never passed; `scope_key` defaults to `default`; payments stay
 *   `pending_activation` (formation is governance-only).
 * Invariants: REPO_SPEC_IS_IDENTITY_SSOT — `node_id` is the single identity authority. SCOPE_ID_IS_DERIVED
 *   — `scope_id = uuidv5("default", node_id)`, matching `features/nodes/repo-spec-builder`. FORMATION_IS_GOVERNANCE_ONLY.
 *   TEMPLATE_SPEC_SHAPE — minting should be value substitution against the node-template repo-spec,
 *   not a thinner generated replacement. BORN_REVIEWABLE — the template's default review `gates:`
 *   MUST remain. EPOCH_ACTIVE_BY_DEFAULT — the template's `activity_ledger:` block MUST remain so
 *   ledger ingest schedules are synthesized by @cogni/repo-spec.
 * Side-effects: none — pure function, no IO, no env.
 * Links: nodes/node-template/.cogni/repo-spec.yaml, nodes/node-template/.cogni/rules/, src/features/nodes/repo-spec-builder.ts, docs/spec/node-ci-cd-contract.md, task.5092
 * @public
 */

import { v5 as uuidv5 } from "uuid";

import type { NodeKnowledgeRemote } from "../knowledge-remote";

export interface RenderRepoSpecInput {
  readonly slug: string;
  readonly repoOwner: string;
  readonly nodeId: string;
  readonly chainId: number;
  readonly daoContract?: string | undefined;
  readonly pluginContract?: string | undefined;
  readonly signalContract?: string | undefined;
  readonly knowledgeRemote?: NodeKnowledgeRemote | undefined;
}

/** uuidv5 of the scope key under the node_id namespace — matches `repo-spec-builder`'s derivation. */
function deriveScopeId(nodeId: string): string {
  return uuidv5("default", nodeId);
}

/** Render `.cogni/repo-spec.yaml` for a freshly-formed node (pending payment activation). */
export function renderRepoSpec(input: RenderRepoSpecInput): string {
  const scopeId = deriveScopeId(input.nodeId);
  const daoLines = [
    input.daoContract ? `  dao_contract: "${input.daoContract}"` : undefined,
    input.pluginContract
      ? `  plugin_contract: "${input.pluginContract}"`
      : undefined,
    input.signalContract
      ? `  signal_contract: "${input.signalContract}"`
      : undefined,
    `  chain_id: "${input.chainId}"`,
  ]
    .filter((l): l is string => l !== undefined)
    .join("\n");

  const sourceRef = `${input.repoOwner}/${input.slug}`;

  return `# Node Template — repo-spec
#
# Identity for the hub's node-template deployment; node_id MUST match
# infra/catalog/node-template.yaml. Forks renaming this scaffold MUST
# regenerate both UUIDs:
#   node_id:  openssl rand -hex 16 | sed 's/\\(.\\{8\\}\\)\\(.\\{4\\}\\)\\(.\\{4\\}\\)\\(.\\{4\\}\\)\\(.\\{12\\}\\)/\\1-\\2-\\3-\\4-\\5/'
#   scope_id: uuidv5(node_id, "default")
# See docs/spec/identity-model.md, docs/spec/multi-node-tenancy.md.

schema_version: "0.1.4"

node_id: "${input.nodeId}"
scope_id: "${scopeId}"
scope_key: "default"

intent:
  name: ${input.slug}

cogni_dao:
${daoLines}

${input.knowledgeRemote ? renderKnowledgeBlock(input.knowledgeRemote) : ""}

# Activity ledger ingestion + approver allowlist.
# \`approvers\` gates the \`(admin)/\` route group and write routes under
# \`/api/v1/attribution/*\`. Replace with the fork's DAO-owner wallet(s) when
# spinning up a new node from this template.
activity_ledger:
  epoch_length_days: 7
  approvers:
    - "0x070075F1389Ae1182aBac722B36CA12285d0c949" # derekg1729.eth (template default)
  activity_sources:
    github:
      attribution_pipeline: cogni-v0.0
      source_refs: ["${sourceRef}"]

payments:
  status: pending_activation

# Born-reviewable default gates. When this node is minted as a single-node fork
# (node-at-root, no \`nodes:\` registry) the operator's review path runs these gates
# against the repo-root \`.cogni/rules/\` below. The mint (\`renderRepoSpec\`) re-emits
# this same block onto the minted repo's identity spec — keep the two in lockstep.
# Gate set coordinated with the operator review path (Lane A). Tune per node.
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
`;
}

function renderKnowledgeBlock(remote: NodeKnowledgeRemote): string {
  return `knowledge:
  database: "${remote.database}"
  remote:
    provider: dolthub
    owner: "${remote.owner}"
    repo: "${remote.repo}"
    url: "${remote.url}"
    custody: cogni-owned`;
}
