// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@ports/node-runtime.port`
 * Purpose: The two read seams the node-deploy sequencer needs to give a node app the SAME runtime
 *   env the retired Crossplane lane gave it (task.5405, story.5127): the node's runtime secrets, read
 *   (OpenBao custody, rendered by ESO), and the node's catalog row (slug + placement policy), read from the operator image.
 * Scope: Types, one error class. No IO.
 * Invariants:
 *   - READ_ONLY_CUSTODY: neither port can write OpenBao. Secrets reach the sequencer through the existing
 *     OpenBao -> ESO (`eso-reader`) -> Secret path; no new OpenBao role exists.
 *   - NO_HALF_ENV: a missing or unreadable key is an ERROR with the key NAMES, never a value-less
 *     env var. The sequencer maps it to "dependency not ready" and creates nothing.
 *   - NO_VALUES_IN_ERRORS: `NodeRuntimeSecretsError` carries key names and a stable code only.
 * Side-effects: none
 * Links: features/node-deploy/node-app-env.ts, task.5405
 * @public
 */

export type NodeRuntimeSecretsErrorCode =
  /** One or more required keys are absent or empty in the node's OpenBao bucket. */
  | "missing_keys"
  /** The ExternalSecret is not Ready (yet), or the Kubernetes API refused or failed the read. */
  | "unavailable";

export class NodeRuntimeSecretsError extends Error {
  constructor(
    readonly code: NodeRuntimeSecretsErrorCode,
    message: string,
    /** Key NAMES only. Never values. */
    readonly keys: readonly string[] = []
  ) {
    super(message);
    this.name = "NodeRuntimeSecretsError";
  }
}

export interface NodeRuntimeSecretsPort {
  /**
   * Read the node's own bucket `cogni/<env>/<slug>` and return every key that may enter an
   * off-cluster workload: well-formed env names, minus the operator/fleet/substrate denylist
   * (denied keys are DROPPED, never returned). Throws `NodeRuntimeSecretsError("missing_keys")` when
   * any of `requiredKeys` is absent or empty after that filter, so it never returns a half env.
   */
  read(
    env: string,
    slug: string,
    requiredKeys: readonly string[]
  ): Promise<Readonly<Record<string, string>>>;
}

/** One node's identity and placement policy as the operator image's catalog states it. */
export interface NodeCatalogEntry {
  readonly slug: string;
  /** The raw catalog row; the sequencer's feature code parses the cells it needs. */
  readonly row: unknown;
}

export interface NodeCatalogPort {
  /** The catalog entry whose node id is `nodeId`, or undefined when the image does not know it. */
  entryFor(nodeId: string): Promise<NodeCatalogEntry | undefined>;
}
