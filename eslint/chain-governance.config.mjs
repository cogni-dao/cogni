// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@eslint/chain-governance.config.mjs`
 * Purpose: Enforce canonical chain configuration usage in production code.
 * Scope: Bans hardcoded chain ID literals (11155111 Sepolia, 8453 Base) outside of chain.ts and tests.
 * Invariants: Canonical chain IDs (Sepolia, Base) must come from @/shared/web3/chain in production code.
 * Side-effects: none
 * Links: https://node-template.cognidao.org/knowledge/chain-config-governance, src/shared/web3/chain.ts
 * @public
 */

/** @type {import('eslint').Linter.Config[]} */
export default [
  // ========================================
  // CHAIN CONFIG SAFETY: Ban hardcoded chain IDs in production code
  // ========================================
  {
    files: ["nodes/*/app/src/**/*.{ts,tsx}"],
    // Exclude tests (fixtures may need literals) and styles (cannot influence runtime chain selection)
    ignores: ["**/*.{test,spec}.{ts,tsx}", "nodes/*/app/src/styles/**"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "Literal[value=11155111]",
          message:
            "Do not hardcode Sepolia chain ID (11155111). Import CHAIN_ID, CHAIN_CONFIG, or CHAINS from @/shared/web3/chain",
        },
        {
          selector: "Literal[value=8453]",
          message:
            "Do not hardcode Base chain ID (8453). Import CHAIN_ID, CHAIN_CONFIG, or CHAINS from @/shared/web3/chain",
        },
      ],
    },
  },

  // Chain config source: allow chain IDs in canonical definition
  // Note: This disables ALL no-restricted-syntax rules in chain.ts, which is acceptable
  // given the file's narrow scope as the single source of truth for chain config.
  {
    files: ["nodes/*/app/src/shared/web3/chain.ts"],
    rules: {
      "no-restricted-syntax": "off",
    },
  },
];
