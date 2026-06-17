// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@shared/secrets/node-secrets-reserved`
 * Purpose: Gate 2 for node self-serve secret writes — a DENYLIST, not an allowlist.
 *   A node owner (OpenFGA `can_manage_secrets`) owns their ENTIRE namespace
 *   `cogni/<env>/<node>/*` and may set/rotate/ADD any key there — that is the
 *   scope (per-node, not shared). The only keys they may NOT touch are the small,
 *   fixed set the SUBSTRATE generates/derives into that same path (DB creds, DSNs,
 *   identity material); overwriting one would break the node's own DB/sessions.
 * Invariants:
 *   - DENYLIST_NOT_ALLOWLIST: new keys are allowed by default. The security
 *     boundary is OpenFGA per-node + the operator-stamped `cogni/<env>/<node>/*`
 *     path + the OpenBao `_system`/`_shared` policy deny — NOT a per-key list.
 *     This needs no per-node codegen and never blocks a node adding a new key.
 *   - SUBSTRATE_OWNS_DB_CREDS: the reserved set mirrors secrets-management.md
 *     Invariant 15 (DB role material is OpenBao/substrate-owned). Fixed +
 *     operator-domain — independent of any node's catalog.
 * Side-effects: none
 * Links: docs/design/node-self-serve-secrets.md, docs/spec/secrets-management.md
 * @public
 */

/**
 * Substrate-managed keys living in a node's own `cogni/<env>/<node>/*` path.
 * Generated/derived by `secret-materialize` + the DB provisioners — a node owner
 * must not clobber them via self-serve (it would break their node's DB/DSN/auth).
 */
export const SUBSTRATE_RESERVED_KEYS: ReadonlySet<string> = new Set<string>([
  "APP_DB_PASSWORD",
  "APP_DB_SERVICE_PASSWORD",
  "APP_DB_READONLY_PASSWORD",
  "DOLTGRES_PASSWORD",
  "DOLTGRES_READER_PASSWORD",
  "DOLTGRES_WRITER_PASSWORD",
  "DATABASE_URL",
  "DATABASE_SERVICE_URL",
  "DOLTGRES_URL",
  "POSTGRES_ROOT_PASSWORD",
  "AUTH_SECRET",
]);

/**
 * Gate 2: may a node owner self-serve `key` within their OWN namespace? True for
 * any key EXCEPT the substrate-reserved set. The KEY format is validated upstream
 * (route Zod) and the path is operator-stamped to the authorized node, so this is
 * the only per-key restriction — a footgun guard, not the security boundary.
 */
export function isNodeOwnedSecretKey(key: string): boolean {
  return !SUBSTRATE_RESERVED_KEYS.has(key);
}
