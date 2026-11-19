// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/review/subject-grounding`
 * Purpose: Load the host-owned preamble sources of a review whose code subject is ANOTHER node (task.5448):
 *   that node's governing index, its architect entry (the id comes from the index), its origin, and its
 *   mission with provenance from its repo-spec at the base SHA.
 * Scope: Reads only, through the signed remote reader and the operator's GitHub App. Runs once per review
 *   run, before any model call. It never reads the operator's own hub.
 * Invariants:
 *   - NO_OPERATOR_FALLBACK: every source is the subject's; a failed read throws, it is never `[]` or omitted
 *     silently. A remote failure carries its typed code (`remote_access_requested`, `remote_policy_denied`,
 *     `remote_unavailable`) as an `AiExecutionError`.
 *   - IDS_FROM_THE_INDEX: the architect entry id is picked from the subject's own index rows (`selectArchitectEntryId`,
 *     no slug pattern). Absent or empty, the review proceeds without it (one structured warn), as it does for the
 *     operator's own node.
 *   - MISSION_PROVENANCE: the mission text is `intent.mission` of the subject's `.cogni/repo-spec.yaml` read at the
 *     base SHA; the source reference names repo and base SHA. `buildSha` stays the operator's serving build, because
 *     the review machine block reports the build that judged the PR.
 *   - SUBJECT_IS_THE_NODE: a repo-spec whose `node_id` is not the subject's refuses the run.
 * Side-effects: IO (signed GET to the linked node, GitHub App contents read)
 * Links: src/adapters/server/ai/langgraph/inproc.provider.ts, https://cognidao.org/knowledge/operator-identity-model
 * @internal
 */

import { AiExecutionError } from "@cogni/ai-core";
import { parse as parseYaml } from "yaml";
import {
  readIndexRows,
  type SubjectGrounding,
  type SubjectGroundingLoader,
  selectArchitectEntryId,
  toRemoteExecutionError,
} from "@/adapters/server";
import type { LinkTarget } from "@/shared/config";
import { findServiceLinkTarget } from "@/shared/config";
import {
  getRemoteReaderRegistry,
  type RemoteReaderRegistry,
} from "./remote-knowledge";

const REPO_SPEC_PATH = ".cogni/repo-spec.yaml";

/** `node_id` and `intent.mission` of a repo-spec document; each undefined when absent or not a string. */
export function readMissionFromRepoSpec(text: string): {
  nodeId: string | undefined;
  mission: string | undefined;
} {
  const doc = parseYaml(text) as unknown;
  if (!doc || typeof doc !== "object") {
    return { nodeId: undefined, mission: undefined };
  }
  const spec = doc as { node_id?: unknown; intent?: { mission?: unknown } };
  const mission = spec.intent?.mission;
  return {
    nodeId: typeof spec.node_id === "string" ? spec.node_id : undefined,
    mission: typeof mission === "string" ? mission : undefined,
  };
}

export function createSubjectGroundingLoader(deps: {
  readonly readCommitFile: (input: {
    nodeId: string;
    origin: string;
    owner: string;
    repo: string;
    commitSha: string;
    path: string;
  }) => Promise<string | null>;
  /** The operator's serving build: the reviewer's identity in the review machine block. */
  readonly operatorBuildSha: string | null;
  readonly log: {
    warn(fields: Record<string, unknown>, message: string): void;
  };
  readonly findTarget?: (nodeId: string) => LinkTarget | undefined;
  readonly registry?: RemoteReaderRegistry;
}): SubjectGroundingLoader {
  return async (subject): Promise<SubjectGrounding> => {
    const target = (deps.findTarget ?? findServiceLinkTarget)(subject.nodeId);
    if (!target) {
      throw new AiExecutionError("invalid_request", "subject_not_linked");
    }
    const registry = deps.registry ?? getRemoteReaderRegistry();
    if (!registry.available) {
      throw new AiExecutionError("internal", "remote_transport_unavailable");
    }
    const reader = registry.forTarget(target);

    // 1. The subject's index. A refusal here (Off, access asked, unreachable) ends the run with its typed code.
    let governingIndex: SubjectGrounding["governingIndex"];
    try {
      governingIndex = await readIndexRows(reader, target.alias);
    } catch (error) {
      throw toRemoteExecutionError(error);
    }

    // 2. The architect entry, its id taken from that index.
    let architect: SubjectGrounding["architect"];
    const architectId = selectArchitectEntryId(governingIndex);
    if (architectId) {
      let content: string | undefined;
      try {
        content = (await reader.get(target.alias, architectId))?.content;
      } catch (error) {
        throw toRemoteExecutionError(error);
      }
      if (content?.trim()) {
        architect = {
          id: architectId,
          content,
          sourceRef: `hub:${target.alias}:${architectId}`,
        };
      }
    }
    if (!architect) {
      deps.log.warn(
        {
          alias: target.alias,
          reason: architectId ? "empty_body" : "no_unique_architect_entry",
        },
        "subject architect not injected; proceeding without it"
      );
    }

    // 3. The mission and its provenance: the subject's repo-spec at the base SHA.
    let specText: string | null;
    try {
      specText = await deps.readCommitFile({
        nodeId: subject.nodeId,
        origin: target.origin,
        owner: subject.owner,
        repo: subject.repo,
        commitSha: subject.baseSha,
        path: REPO_SPEC_PATH,
      });
    } catch {
      specText = null;
    }
    if (!specText) {
      throw new AiExecutionError("internal", "subject_repo_spec_unavailable");
    }
    let parsed: ReturnType<typeof readMissionFromRepoSpec>;
    try {
      parsed = readMissionFromRepoSpec(specText);
    } catch {
      throw new AiExecutionError("internal", "subject_repo_spec_invalid");
    }
    if (parsed.nodeId !== undefined && parsed.nodeId !== subject.nodeId) {
      throw new AiExecutionError("internal", "subject_repo_spec_node_mismatch");
    }
    if (!parsed.mission?.trim()) {
      throw new AiExecutionError("internal", "subject_mission_unavailable");
    }

    return {
      nodeId: subject.nodeId,
      origin: target.origin,
      mission: {
        content: parsed.mission,
        sourceRef: `${subject.owner}/${subject.repo}@${subject.baseSha.slice(0, 12)}:${REPO_SPEC_PATH}#intent.mission`,
        buildSha: deps.operatorBuildSha,
      },
      governingIndex,
      ...(architect ? { architect } : {}),
    };
  };
}
