// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/linked-node-source.port`
 * Purpose: Port for the host-owned reader of a LINKED node's grounding (story.0038): the mission, the
 *   governing index, the architect entry and the rule bodies of node X, read through X's X-issued key.
 * Scope: Types only. The adapter-side composition lives in `bootstrap/review/linked-node-source.ts`.
 * Invariants:
 *   - HOST_READS_REMOTE_HUB: the host, not the model, reads X's hub; the result goes into the host
 *     preamble. No remote knowledge tool exists in v0.
 *   - SUBJECT_IS_HOST_BOUND: the reader takes the validated code subject, never a model argument.
 * Side-effects: none (interface only)
 * Links: https://node-template.cognidao.org/knowledge/node-service-enrollment, story.0038
 * @public
 */

/** The validated code subject of a review run (the host-bound repo and commits). */
export interface LinkedNodeSubject {
  readonly nodeId: string;
  readonly owner: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly headSha: string;
}

/** The grounding the host read from node X. */
export interface LinkedNodeSource {
  /** X's registered origin (`https://<host>`). */
  readonly origin: string;
  readonly mission: {
    readonly content: string;
    readonly sourceRef: string;
    readonly buildSha: string | null;
  };
  readonly governingIndex: ReadonlyArray<{
    readonly id: string;
    readonly domain: string;
    readonly entryType: string;
    readonly useWhen: string;
  }>;
  readonly architect?: {
    readonly id: string;
    readonly content: string;
    readonly sourceRef: string;
  };
  /** Full bodies of the index rows of type `rule` (at most 20 entries, 96 KiB). */
  readonly rules: ReadonlyArray<{
    readonly id: string;
    readonly content: string;
  }>;
}

/** Why a linked-node read failed; the run fails closed with it. */
export class LinkedNodeSourceError extends Error {
  constructor(
    readonly code:
      | "node_not_linked"
      | "node_origin_unresolved"
      | "node_key_rejected"
      | "node_hub_unreadable"
      | "node_mission_unavailable"
  ) {
    super(code);
    this.name = "LinkedNodeSourceError";
  }
}

/** Read X's grounding for one linked review run. @throws LinkedNodeSourceError */
export type LinkedNodeSourceReader = (
  subject: LinkedNodeSubject
) => Promise<LinkedNodeSource>;
