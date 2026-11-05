// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/**
 * Module: `@scripts/lib/print-secret-inheritance`
 * Purpose: Emit catalog-owned inherited secret references for one lane/custodian.
 * Scope: Catalog reference resolution. Does NOT read secret values, write runtime state, or select endpoints.
 * Invariants: the typed catalog resolver is the sole inherited-owner selector.
 * Side-effects: IO (reads catalog files; writes nonsecret JSON to stdout).
 * Links: https://cognidao.org/work/items/bug.5571
 */
import {
  inheritedSecretOwner,
  loadSecretsCatalog,
} from "./secrets-catalog-loader";

const [repoRoot, lane, control] = process.argv.slice(2);
if (!repoRoot || !lane || !control || process.argv.length !== 5)
  throw new Error(
    "Usage: print-secret-inheritance.ts <repo-root> <lane> <control>"
  );
const { routing } = loadSecretsCatalog({ repoRoot });
const owners: Record<string, { environment: string; service: string }> = {};
for (const [key, entry] of Object.entries(routing)) {
  const owner = inheritedSecretOwner(entry, lane, control);
  if (owner) owners[key] = owner;
}
process.stdout.write(`${JSON.stringify(owners)}\n`);
