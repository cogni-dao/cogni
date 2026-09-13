// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-wallet.test`
 * Purpose: Prove ONE_WALLET_ONE_WRITER is structural — there is no input that yields a usable
 *   actuator wallet identity while the legacy ComputeWorkload controller's credential is in play.
 * Scope: Pure resolution/refusal unit tests. No env, no IO.
 * Invariants: a missing dedicated credential must NEVER fall back to the legacy one.
 * Side-effects: none
 * Links: ./akash-tx-wallet, task.5095
 * @internal
 */

import { describe, expect, it } from "vitest";

import {
  AkashTxWalletConfigError,
  resolveAkashTxWallet,
} from "./akash-tx-wallet";

const LEGACY = "legacy-controller-console-key";
const ACTUATOR = "dedicated-actuator-console-key";

describe("resolveAkashTxWallet", () => {
  it("resolves a per-environment scope from the dedicated credential", () => {
    expect(
      resolveAkashTxWallet({
        environment: "candidate-a",
        actuatorApiKey: ACTUATOR,
        legacyControllerApiKey: LEGACY,
      })
    ).toEqual({
      walletScope: "akash-console:candidate-a",
      apiKey: ACTUATOR,
    });
  });

  it("scopes each environment separately so one env's Postgres serializes one env's wallet", () => {
    const scopes = ["candidate-a", "preview", "production"].map(
      (environment) =>
        resolveAkashTxWallet({ environment, actuatorApiKey: ACTUATOR })
          .walletScope
    );
    expect(new Set(scopes).size).toBe(3);
  });

  it("derives the scope from the environment, not the secret — rotation cannot orphan receipts", () => {
    const before = resolveAkashTxWallet({
      environment: "production",
      actuatorApiKey: ACTUATOR,
    });
    const after = resolveAkashTxWallet({
      environment: "production",
      actuatorApiKey: "rotated-actuator-console-key",
    });
    expect(after.walletScope).toBe(before.walletScope);
  });

  it("REFUSES to fall back to the legacy controller credential when the dedicated one is unset", () => {
    expect(() =>
      resolveAkashTxWallet({
        environment: "production",
        legacyControllerApiKey: LEGACY,
      })
    ).toThrow(AkashTxWalletConfigError);

    try {
      resolveAkashTxWallet({
        environment: "production",
        legacyControllerApiKey: LEGACY,
      });
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as AkashTxWalletConfigError).code).toBe(
        "actuator_credential_missing"
      );
      // The legacy value must never leak into the refusal.
      expect((error as Error).message).not.toContain(LEGACY);
    }
  });

  it.each([
    "",
    "   ",
  ])("treats a blank dedicated credential (%p) as missing, never as a wallet", (blank) => {
    expect(() =>
      resolveAkashTxWallet({
        environment: "production",
        actuatorApiKey: blank,
        legacyControllerApiKey: LEGACY,
      })
    ).toThrow(/dedicated AKASH_ACTUATOR_CONSOLE_API_KEY/);
  });

  it("REFUSES a dedicated credential that is byte-equal to the legacy writer's", () => {
    try {
      resolveAkashTxWallet({
        environment: "candidate-a",
        actuatorApiKey: LEGACY,
        legacyControllerApiKey: LEGACY,
      });
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as AkashTxWalletConfigError).code).toBe(
        "actuator_credential_shared_with_legacy_writer"
      );
    }
  });

  it("refuses whitespace-padded aliasing of the legacy credential", () => {
    expect(() =>
      resolveAkashTxWallet({
        environment: "candidate-a",
        actuatorApiKey: `  ${LEGACY}  `,
        legacyControllerApiKey: LEGACY,
      })
    ).toThrow(AkashTxWalletConfigError);
  });

  it("requires an environment — an unscoped ledger serializes nothing", () => {
    expect(() =>
      resolveAkashTxWallet({ environment: "", actuatorApiKey: ACTUATOR })
    ).toThrow(/DEPLOY_ENVIRONMENT/);
  });
});
