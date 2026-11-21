// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@shared/node-app-scaffold/gens/node-wallet-spec`
 * Purpose: Pure splice of ONE fact into an existing node repo-spec YAML: `operator_wallet.address`,
 *   the public address of the wallet the wizard created for the node (story.0083).
 * Scope: String transform over the current `.cogni/repo-spec.yaml` text. No IO, no env, no YAML
 *   round-trip (comments and ordering are preserved). The adapter reads the file and opens the PR.
 * Invariants:
 *   - ADDRESS_ONLY: the only key written is `operator_wallet.address`. Nothing else in the spec moves.
 *   - IDEMPOTENT_SPLICE: splicing an address the spec already names is an identical string.
 *   - NEVER_OVERWRITE_A_NAMED_WALLET: callers check `specNamesOperatorWallet` first; a spec that
 *     already names a wallet is a conflict, not something this splice replaces.
 * Side-effects: none
 * Links: src/adapters/server/vcs/github-repo-write.ts, https://node-template.cognidao.org/knowledge/set-up-operator-wallet
 * @public
 */

import { parse as parseYaml } from "yaml";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The `operator_wallet.address` the spec names, or null when absent or unparseable. */
export function readSpecOperatorWalletAddress(spec: string): string | null {
  let parsed: unknown;
  try {
    parsed = parseYaml(spec);
  } catch {
    return null;
  }
  const wallet = asRecord(asRecord(parsed)?.operator_wallet);
  const address = wallet?.address;
  return typeof address === "string" && address.trim() !== "" ? address : null;
}

export function specNamesOperatorWallet(spec: string): boolean {
  return readSpecOperatorWalletAddress(spec) !== null;
}

/** Top-level `operator_wallet:` line plus its indented continuation lines. */
const OPERATOR_WALLET_BLOCK = /(^|\n)operator_wallet:[^\n]*(?:\n[ \t]+[^\n]*)*/;

/**
 * Write `operator_wallet.address` into the spec: replace an existing (address-less) `operator_wallet`
 * block, else append one. Deterministic and idempotent.
 */
export function renderNodeWalletSpec(
  current: string,
  walletAddress: string
): string {
  const block = `operator_wallet:\n  address: "${walletAddress}"`;
  const out = current.replace(/\s*$/, "\n");
  const match = OPERATOR_WALLET_BLOCK.exec(out);
  if (match) {
    const leading = match[1] ?? "";
    return out
      .replace(OPERATOR_WALLET_BLOCK, `${leading}${block}`)
      .replace(/\n*$/, "\n");
  }
  return `${out}\n${block}\n`;
}
