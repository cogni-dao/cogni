// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/repo-spec`
 * Purpose: Specialize the exact `.cogni/repo-spec.yaml` inherited from node-template with a new
 *   node's web3 identity and governance values, without rebuilding or thinning template features.
 * Scope: Pure transformer over the inherited template spec plus server-verified DAO addresses +
 *   identity. `scope_id` is derived from `node_id` (uuidv5), never passed; `scope_key` defaults to
 *   `default`; payments stay `pending_activation` (formation is governance-only).
 * Invariants: REPO_SPEC_IS_IDENTITY_SSOT — `node_id` is the single identity authority. SCOPE_ID_IS_DERIVED
 *   — `scope_id = uuidv5("default", node_id)`, matching `features/nodes/repo-spec-builder`. FORMATION_IS_GOVERNANCE_ONLY.
 *   TEMPLATE_SPEC_SHAPE — minting is value substitution against the exact inherited node-template
 *   repo-spec, never a thinner generated replacement. Consequently new template-owned substrate
 *   such as `schedules:` and private services propagates to every later wizard spawn automatically.
 *   BORN_REVIEWABLE — the template's default review `gates:` MUST remain. EPOCH_ACTIVE_BY_DEFAULT —
 *   the template's `activity_ledger:` block MUST remain so ledger ingest schedules are synthesized
 *   by @cogni/repo-spec. BORN_DEPLOYABLE — the template's complete `deployment:` block MUST remain
 *   so a fresh node is off-cluster-compute capable with zero hand-editing.
 * Side-effects: none — pure function, no IO, no env.
 * Links: Cogni-DAO/node-template:.cogni/repo-spec.yaml, src/features/nodes/repo-spec-builder.ts, docs/spec/node-ci-cd-contract.md, task.5092, task.5079
 * @public
 */

import { parseRepoSpec } from "@cogni/repo-spec";
import { v5 as uuidv5 } from "uuid";
import { parseDocument } from "yaml";

import type { NodeKnowledgeRemote } from "../knowledge-remote";

export interface RenderRepoSpecInput {
  /** Exact node-template repo-spec from the fork's inherited base commit. */
  readonly templateRepoSpec: string;
  readonly slug: string;
  readonly repoOwner: string;
  readonly nodeId: string;
  readonly chainId: number;
  readonly daoContract?: string | undefined;
  readonly pluginContract?: string | undefined;
  readonly signalContract?: string | undefined;
  readonly tokenContract?: string | undefined;
  readonly knowledgeRemote?: NodeKnowledgeRemote | undefined;
  /**
   * One-line node mission (`intent.mission`) — the north-star the cognition
   * substrate surfaces at session start. Formation has no UI to capture this
   * yet, so a starter seed is emitted by default for the launch agent to refine.
   */
  readonly mission?: string | undefined;
}

/** uuidv5 of the scope key under the node_id namespace — matches `repo-spec-builder`'s derivation. */
function deriveScopeId(nodeId: string): string {
  return uuidv5("default", nodeId);
}

/**
 * Starter `intent.mission` for a freshly-minted node: a refine-me seed so every
 * new node ships with a mission the launch agent narrows in `.cogni/repo-spec.yaml`
 * (and a matching `<slug>-agent-orientation` hub entry it refines as the repo grows).
 */
function starterMission(slug: string): string {
  return `Define ${slug}'s one-line mission here — refine in .cogni/repo-spec.yaml (surfaced at session start).`;
}

/**
 * Specialize the inherited template spec for a freshly-formed node.
 *
 * Only identity/governance-owned values are replaced. Every other top-level capability remains
 * template-owned, so a newly added schedule, worker, gate, payment default, or future substrate
 * block reaches wizard spawns without a corresponding operator renderer edit.
 */
export function renderRepoSpec(input: RenderRepoSpecInput): string {
  const scopeId = deriveScopeId(input.nodeId);
  const sourceRef = `${input.repoOwner}/${input.slug}`;
  const document = parseDocument(input.templateRepoSpec);
  if (document.errors.length > 0) {
    throw new Error(
      `node-template repo-spec is invalid YAML: ${document.errors.map((error) => error.message).join("; ")}`
    );
  }

  document.setIn(["node_id"], input.nodeId);
  document.setIn(["scope_id"], scopeId);
  document.setIn(["scope_key"], "default");
  document.setIn(["intent", "name"], input.slug);
  document.setIn(
    ["intent", "mission"],
    input.mission ?? starterMission(input.slug)
  );
  // A fresh node must not present itself with node-template's tagline or visual identity. Formation
  // has no hook/brand inputs yet, so omit them and let the node's standard slug/monogram fallbacks
  // render until its launch agent authors sovereign values.
  document.deleteIn(["intent", "hook"]);
  document.deleteIn(["intent", "brand"]);

  document.setIn(["governance"], {
    ...(input.daoContract ? { dao_contract: input.daoContract } : {}),
    ...(input.pluginContract ? { plugin_contract: input.pluginContract } : {}),
    ...(input.signalContract ? { signal_contract: input.signalContract } : {}),
    ...(input.tokenContract ? { token_contract: input.tokenContract } : {}),
    chain_id: String(input.chainId),
    // Governance proposal-UI host for the PR-review `/propose/merge` deep-link.
    // Shared, env-agnostic — NOT the node's own app URL.
    base_url: "https://proposal.cognidao.org",
  });

  if (input.knowledgeRemote) {
    document.setIn(["knowledge"], {
      database: input.knowledgeRemote.database,
      remote: {
        provider: "dolthub",
        owner: input.knowledgeRemote.owner,
        repo: input.knowledgeRemote.repo,
        url: input.knowledgeRemote.url,
        custody: "cogni-owned",
      },
    });
  } else {
    document.deleteIn(["knowledge"]);
  }

  document.setIn(
    ["activity_ledger", "activity_sources", "github", "source_refs"],
    [sourceRef]
  );
  document.setIn(["payments"], { status: "pending_activation" });
  document.setIn(["distributions"], { status: "pending_activation" });

  const rendered = document.toString({ lineWidth: 0 });
  // The inherited template plus substitutions must still satisfy the canonical parser. This is
  // the mint boundary, so fail before the operator writes an invalid identity commit.
  parseRepoSpec(rendered);
  return rendered;
}
