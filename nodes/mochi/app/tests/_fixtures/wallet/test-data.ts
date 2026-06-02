// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/wallet/test-data`
 * Purpose: Shared wallet test data and expectations.
 * Scope: Provides constants for wallet addresses, API keys, and account IDs used across tests. Does not contain test logic or HTTP helpers.
 * Invariants: Stable test data that matches .env.test configuration
 * Side-effects: none
 * Notes: Single source of truth for wallet test fixtures
 * Links: Used by unit and stack tests
 * @public
 */

import { deriveAccountIdFromApiKey } from "@cogni/node-shared";

// Expected API key from .env.test LITELLM_MVP_API_KEY
export const TEST_MVP_API_KEY = "test-mvp-api-key";

// Derived account ID for MVP API key
export const TEST_MVP_ACCOUNT_ID = deriveAccountIdFromApiKey(TEST_MVP_API_KEY);

// Sample wallet addresses for testing
export const SAMPLE_WALLET_ADDRESSES = {
  VALID_EVM: "0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb",
  VALID_EVM_2: "0x1234567890abcdefABCDEF1234567890abcdefAB",
  VALID_EVM_3: "0xABCDEF1234567890abcdefABCDEF1234567890ab",
  NON_EVM: "not-a-real-eth-address", // For MVP validation tests
  GENERIC: "0xAnyAddress",
} as const;

// Expected display name formats (0x + first 5 ... last 5)
export const EXPECTED_DISPLAY_NAMES = {
  [SAMPLE_WALLET_ADDRESSES.VALID_EVM]: "Wallet: 0x742d3...f0bEb",
  [SAMPLE_WALLET_ADDRESSES.VALID_EVM_2]: "Wallet: 0x12345...defAB",
} as const;

// Account ID format regex
export const ACCOUNT_ID_FORMAT = /^key:[a-f0-9]{32}$/;
