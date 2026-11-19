// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/scoped-knowledge`
 * Purpose: The run-scoped knowledge capability the review reader tools bind to (task.5448), like
 *   `node-code.ts` `scoped()`. Without a code subject, or with the operator's own node as subject, every
 *   call goes to the local Doltgres capability unchanged. With another listed node as subject, every call
 *   goes to that node's hub through the signed remote reader, and write methods throw.
 * Scope: Chooses the capability per call from the run's execution scope. Does no IO itself.
 * Invariants:
 *   - SELF_IS_LOCAL: no subject, or `subject.nodeId` equal to this node's id, is exactly the local capability.
 *   - OTHER_IS_REMOTE_ONLY: for another node there is NO operator fallback. A subject that is not a listed
 *     target, a missing reader or a failed read throws; it never reads the operator's own hub.
 *   - READS_ONLY_FOR_OTHER: `write` on a remote subject throws (the adapter has no write).
 *   - RUN_SCOPED: the choice is read from the execution scope at call time; nothing is stored per run.
 * Side-effects: none
 * Links: src/bootstrap/capabilities/node-code.ts, https://cognidao.org/knowledge/operator-identity-model
 * @internal
 */

import type { KnowledgeCapability } from "@cogni/ai-tools";

export function createScopedKnowledgeCapability(deps: {
  /** The operator's own Doltgres capability. */
  readonly local: KnowledgeCapability;
  /** This node's id. */
  readonly nodeId: string;
  /** The run's code subject node id, or undefined outside a run or without a subject. */
  readonly getSubjectNodeId: () => string | undefined;
  /** The remote capability for a listed node id; throws when the node is not listed or no reader exists. */
  readonly remoteFor: (nodeId: string) => KnowledgeCapability;
}): KnowledgeCapability {
  function resolve(): KnowledgeCapability {
    const subject = deps.getSubjectNodeId();
    if (subject === undefined || subject === deps.nodeId) return deps.local;
    return deps.remoteFor(subject);
  }
  const wrapper: KnowledgeCapability = {
    // Async on purpose: a refusal from `resolve()` is a rejected promise, as every other failure is.
    search: async (params) => resolve().search(params),
    list: async (params) => resolve().list(params),
    get: async (id) => resolve().get(id),
    write: async (params) => resolve().write(params),
  };
  if (deps.local.listGoverningIndex) {
    wrapper.listGoverningIndex = async () => {
      const capability = resolve();
      if (!capability.listGoverningIndex)
        throw new Error("knowledge_index_unavailable");
      return capability.listGoverningIndex();
    };
  }
  if (deps.local.listActiveGoals) {
    wrapper.listActiveGoals = async () => {
      const capability = resolve();
      if (!capability.listActiveGoals)
        throw new Error("knowledge_goals_unavailable");
      return capability.listActiveGoals();
    };
  }
  return wrapper;
}
