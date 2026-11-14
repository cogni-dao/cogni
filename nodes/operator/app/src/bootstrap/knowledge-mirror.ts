// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/knowledge-mirror`
 * Purpose: Resolve the DoltHub mirror remote for THIS node's knowledge push.
 * Scope: Pure runtime wiring helper; no network IO.
 * Invariants:
 *   - DERIVED_IDENTITY_IS_DEFAULT: a node's mirror remote is CANONICALLY
 *     derived from its identity — `buildNodeKnowledgeRemote(slug, owner)` →
 *     `<owner>/<slug>`. Explicit config is an OVERRIDE, never the primary
 *     source. Same principle as `agentId = providerId:graphName`
 *     (derived, never registered): identity is computed from the node, not
 *     hand-typed. This is what lets the operator-as-librarian auto-mirror
 *     every sub-registry node with zero per-node wiring.
 *   - PRECEDENCE: explicit env override (throwaway isolation) > repo-spec
 *     `knowledge.remote.url` (custody exception) > derived default.
 *   - FAIL_CLOSED_ON_OWNER: with no override AND no repo-spec block AND no
 *     `owner` (DOLTHUB_OWNER), this returns undefined ⇒ mirror disabled. A
 *     missing owner NEVER falls back to a hard-coded org — that would push a
 *     non-prod env into the prod DoltHub org (infra/secrets-catalog.yaml:
 *     "Do not point test/preview at cogni-dao").
 * Side-effects: none
 * Links: docs/runbooks/dolthub-remote-bootstrap.md,
 *   @shared/node-app-scaffold/knowledge-remote (buildNodeKnowledgeRemote)
 * @internal
 */

import type { KnowledgeConfig } from "@/shared/config";
import { buildNodeKnowledgeRemote } from "@/shared/node-app-scaffold/knowledge-remote";

export interface NodeKnowledgeRemoteInput {
  /** This node's slug (repo-spec `intent.name`) — the `<slug>` in `<owner>/<slug>`. */
  readonly slug: string | undefined;
  /** DoltHub org that owns this env's node repos (`DOLTHUB_OWNER`). */
  readonly owner: string | undefined;
  /** Explicit per-env override URL (`KNOWLEDGE_DOLTHUB_REMOTE_URL`) — throwaway isolation. */
  readonly override?: string | undefined;
  /** repo-spec `knowledge` block — a custody-exception override, not the default. */
  readonly repoSpec?: KnowledgeConfig | undefined;
}

/**
 * Resolve THIS node's DoltHub mirror remote URL. Derivation is the default;
 * config is the override. Returns undefined ⇒ mirror disabled (fail-closed).
 */
export function resolveNodeKnowledgeRemoteUrl(
  input: NodeKnowledgeRemoteInput
): string | undefined {
  if (input.override) return input.override;
  if (input.repoSpec?.remote.url) return input.repoSpec.remote.url;
  if (input.slug && input.owner) {
    return buildNodeKnowledgeRemote(input.slug, input.owner).url;
  }
  return undefined;
}
