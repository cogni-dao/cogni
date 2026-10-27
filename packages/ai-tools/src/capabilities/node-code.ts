// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@cogni/ai-tools/capabilities/node-code`
 * Purpose: Immutable, host-bound code evidence without repository selection or writes.
 * Scope: Read contracts only; credentials and authorization stay with the node host.
 * Invariants: Unknown accessibility is never absence; complete refers to the requested range or direct listing.
 * Side-effects: none
 * Links: https://cognidao.org/work/items/subtask.5027
 * @public
 */
export interface NodeCodeBinding {
  readonly nodeId: string;
  readonly origin: string;
  readonly owner: string;
  readonly repo: string;
  readonly commitSha: string;
  readonly roots: readonly string[];
  readonly manifests: readonly string[];
}

export interface NodeCodeSource {
  readonly nodeId: string;
  readonly origin: string;
  readonly repo: string;
  readonly commitSha: string;
  readonly path: string;
  readonly citation: string;
  readonly complete: boolean;
  /** false only after a reachable commit and a complete parent tree prove absence. */
  readonly exists: boolean | null;
  readonly reason?: string;
}

export interface NodeCodeReadResult extends NodeCodeSource {
  readonly content: string | null;
  /** Hash of exactly the returned UTF-8 content, not an unread portion of the file. */
  readonly sha256: string | null;
  readonly lineStart: number | null;
  readonly lineEnd: number | null;
  readonly totalLines: number | null;
  readonly fileComplete: boolean;
}

export interface NodeCodeListResult extends NodeCodeSource {
  /** Listing covers admitted code entries only; excluded names do not confer read authority. */
  readonly entries: readonly {
    readonly path: string;
    readonly type: "file" | "directory";
    readonly sha: string;
  }[];
}

export interface NodeCodeCapability {
  read(input: {
    readonly path: string;
    readonly lineStart?: number;
    readonly lineEnd?: number;
  }): Promise<NodeCodeReadResult>;
  list(input: { readonly path: string }): Promise<NodeCodeListResult>;
}
