// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@_fixtures/auth/siwe-helpers`
 * Purpose: Test utilities for SIWE message generation and wallet signing.
 * Scope: Provides reusable helpers for creating and signing SIWE messages in tests. Does not contain test assertions or HTTP logic.
 * Invariants: Deterministic test wallets; valid EIP-4361 message format
 * Side-effects: none
 * Notes: Use for integration tests that need real SIWE signatures without external wallet dependencies.
 * Links: tests/component/auth/siwe-verification.int.test.ts
 * @public
 */

import { SiweMessage } from "siwe";
import type { PrivateKeyAccount } from "viem/accounts";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

export interface TestWallet {
  account: PrivateKeyAccount;
  privateKey: `0x${string}`;
}

/**
 * Generate a deterministic test wallet from a seed phrase or random
 */
export function generateTestWallet(seed?: string): TestWallet {
  // If seed provided, use it to generate deterministic key (for reproducible tests)
  // Otherwise generate random key
  const privateKey = seed
    ? (`0x${Buffer.from(seed).toString("hex").padEnd(64, "0").slice(0, 64)}` as `0x${string}`)
    : generatePrivateKey();

  const account = privateKeyToAccount(privateKey);

  return { account, privateKey };
}

export interface SiweMessageParams {
  domain: string;
  address: string;
  nonce: string;
  chainId?: number;
  expirationTime?: string;
  issuedAt?: string;
}

/**
 * Create a valid SIWE message (EIP-4361 format) for testing
 */
export function createSiweMessage(params: SiweMessageParams): string {
  const siweParams: Partial<{
    domain: string;
    address: string;
    statement: string;
    uri: string;
    version: string;
    chainId: number;
    nonce: string;
    issuedAt: string;
    expirationTime: string;
  }> = {
    domain: params.domain,
    address: params.address,
    statement: "Sign in with Ethereum to the app.",
    uri: `https://${params.domain}`,
    version: "1",
    chainId: params.chainId ?? 1,
    nonce: params.nonce,
    issuedAt: params.issuedAt ?? new Date().toISOString(),
  };

  // Only include expirationTime if provided
  if (params.expirationTime) {
    siweParams.expirationTime = params.expirationTime;
  }

  const message = new SiweMessage(siweParams);

  return message.prepareMessage();
}

/**
 * Sign a SIWE message with a test wallet
 */
export async function signSiweMessage(
  message: string,
  wallet: TestWallet
): Promise<string> {
  return wallet.account.signMessage({ message });
}

/**
 * Create and sign a SIWE message in one call
 */
export async function createAndSignSiweMessage(
  params: SiweMessageParams,
  wallet: TestWallet
): Promise<{ message: string; signature: string }> {
  const message = createSiweMessage(params);
  const signature = await signSiweMessage(message, wallet);
  return { message, signature };
}
