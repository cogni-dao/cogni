// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/validate-chain-config`
 * Purpose: Validate that .cogni/repo-spec.yaml declares the same chain (Base) as the app.
 * Scope: Build/CI-time guard; reads repo spec and compares chain_id to CHAIN_ID. Does not validate wallet env vars (wallet comes directly from repo-spec at runtime).
 * Invariants: Base mainnet only (chain_id 8453); fails fast if chain ID mismatches.
 * Side-effects: IO (reads repo-spec from disk); terminates process on mismatch.
 * Links: .cogni/repo-spec.yaml, src/shared/web3/chain.ts
 * @public
 */

import fs from "node:fs";
import path from "node:path";

import { parse } from "yaml";

// Direct source import: tsx scripts resolve TS files directly.
// Workspace packages use ESM-only exports which tsx CJS loader can't resolve.
import { CHAIN_ID } from "../packages/node-shared/src/web3/chain";

function main(): void {
  const repoSpecPath = path.join(process.cwd(), ".cogni", "repo-spec.yaml");
  if (!fs.existsSync(repoSpecPath)) {
    console.error(
      `[chain-config] Missing repo-spec: expected ${repoSpecPath} to exist`
    );
    process.exit(1);
  }

  const content = fs.readFileSync(repoSpecPath, "utf8");
  const spec = parse(content) as {
    governance?: { chain_id?: unknown };
  };
  const declared = Number(spec?.governance?.chain_id);

  if (!Number.isFinite(declared)) {
    console.error(
      "[chain-config] Invalid or missing governance.chain_id in repo-spec; expected Base mainnet (8453)"
    );
    process.exit(1);
  }

  if (declared !== CHAIN_ID) {
    console.error(
      `[chain-config] Chain mismatch: repo-spec declares ${declared}, app is hardcoded to ${CHAIN_ID} (Base mainnet)`
    );
    process.exit(1);
  }

  console.log(
    `[chain-config] OK: repo-spec chain_id ${declared} matches app CHAIN_ID ${CHAIN_ID} (Base mainnet)`
  );
}

main();
