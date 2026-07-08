// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@ports/operator-secrets-plane`
 * Purpose: Operator-local secrets control plane — node-owner self-serve value writes
 *   to OpenBao (`cogni/<env>/<node>/<KEY>`), authorized by OpenFGA, written by the
 *   operator pod's own in-cluster identity. The value-write complement to the deploy
 *   plane: `developer → can_manage_secrets` → operator-held OpenBao writer → write.
 * Scope: Interface only. Keeps OpenBao writer custody out of shared AI-tool capabilities
 *   and out of the route (the route never holds a token — the adapter does).
 * Invariants:
 *   - OPERATOR_OWNS_WRITER: the pod self-logins with its own SA; no caller token, no kubeconfig.
 *   - PATH_FROM_AUTHORIZED_RESOURCE: node slug + env are operator-derived, never request body.
 *   - NO_SECRETS_IN_CONTEXT: the writer token never leaves the adapter; values never logged.
 * Side-effects: none (interface)
 * Links: docs/design/node-self-serve-secrets.md, src/app/api/v1/nodes/[id]/secrets/route.ts,
 *   src/ports/deploy-plane.port.ts (the deploy-plane sibling this mirrors)
 * @public
 */

export type SecretWriteOp = "set" | "rotate";

export interface WriteNodeSecretInput {
  /** OpenFGA-authorized node slug — taken from the granted `resource`, never the body. */
  readonly nodeSlug: string;
  /** Operator-stamped env from `serverEnv()`, never the body (closes the env axis). */
  readonly env: string;
  /** Catalog-allowlisted A2 key (uppercase + digits + underscores). */
  readonly key: string;
  /** Secret bytes — passed on stdin to `bao`, never argv, never logged. */
  readonly value: string;
  /** `set` (first write → put) or `rotate` (subsequent → patch). */
  readonly op: SecretWriteOp;
}

export interface WriteNodeSecretResult {
  readonly written: boolean;
  /** KV-v2 version the write produced — the synchronous custody observable. */
  readonly version: number;
  /** Resolved OpenBao path: `cogni/<env>/<node>/<KEY>` (no value). */
  readonly path: string;
}

export interface OperatorSecretsPlanePort {
  writeSecret(input: WriteNodeSecretInput): Promise<WriteNodeSecretResult>;
}
