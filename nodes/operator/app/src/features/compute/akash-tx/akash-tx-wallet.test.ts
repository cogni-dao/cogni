// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/compute/akash-tx/akash-tx-wallet.test`
 * Purpose: Prove ONE_WALLET_ONE_WRITER is structural AND that proving it no longer requires the
 *   actuator to possess the wallet it is isolating from (story.5016 secret-boundary amendment 3).
 * Scope: Pure resolution/refusal unit tests. No env, no IO, no network.
 * Invariants:
 *   - the module exposes NO input for the legacy `AKASH_CONSOLE_API_KEY` — it cannot be held;
 *   - a missing credential or a missing/unmatched pinned account id is a fail-closed refusal.
 * Side-effects: none
 * Links: ./akash-tx-wallet, task.5095, story.5016
 * @internal
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  type AkashTxWalletConfigError,
  assertActuatorWalletAccount,
  credentialFingerprint,
  resolveAkashTxWallet,
} from "./akash-tx-wallet";

const ACTUATOR = "operator-sponsor-console-key";
const ACCOUNT = "akash1operatorsponsorwalletaddress";
const OTHER_ACCOUNT = "akash1someotherwalletaddress";

describe("resolveAkashTxWallet", () => {
  it("resolves a per-environment scope from the credential + pinned account", () => {
    expect(
      resolveAkashTxWallet({
        environment: "candidate-a",
        actuatorApiKey: ACTUATOR,
        expectedAccountId: ACCOUNT,
      })
    ).toEqual({
      walletScope: "akash-console:candidate-a",
      apiKey: ACTUATOR,
      expectedAccountId: ACCOUNT,
    });
  });

  it("scopes each environment separately so one env's Postgres serializes one env's wallet", () => {
    const scopes = ["candidate-a", "preview", "production"].map(
      (environment) =>
        resolveAkashTxWallet({
          environment,
          actuatorApiKey: ACTUATOR,
          expectedAccountId: ACCOUNT,
        }).walletScope
    );
    expect(new Set(scopes).size).toBe(3);
  });

  it("derives the scope from the environment, not the secret — rotation cannot orphan receipts", () => {
    const before = resolveAkashTxWallet({
      environment: "production",
      actuatorApiKey: ACTUATOR,
      expectedAccountId: ACCOUNT,
    });
    const after = resolveAkashTxWallet({
      environment: "production",
      actuatorApiKey: "rotated-console-key",
      expectedAccountId: ACCOUNT,
    });
    expect(after.walletScope).toBe(before.walletScope);
  });

  it("REFUSES a missing credential — there is no fallback to any other wallet", () => {
    try {
      resolveAkashTxWallet({
        environment: "production",
        expectedAccountId: ACCOUNT,
      });
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as AkashTxWalletConfigError).code).toBe(
        "actuator_credential_missing"
      );
    }
  });

  it.each([
    "",
    "   ",
  ])("treats a blank credential (%p) as missing, never as a wallet", (blank) => {
    expect(() =>
      resolveAkashTxWallet({
        environment: "production",
        actuatorApiKey: blank,
        expectedAccountId: ACCOUNT,
      })
    ).toThrow(/AKASH_ACTUATOR_CONSOLE_API_KEY/);
  });

  it.each([
    "",
    "   ",
    undefined,
  ])("REFUSES to start without a pinned AKASH_ACTUATOR_ACCOUNT_ID (%p)", (pin) => {
    try {
      resolveAkashTxWallet({
        environment: "candidate-a",
        actuatorApiKey: ACTUATOR,
        expectedAccountId: pin,
      });
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as AkashTxWalletConfigError).code).toBe(
        "actuator_account_id_missing"
      );
    }
  });

  it("requires an environment — an unscoped ledger serializes nothing", () => {
    expect(() =>
      resolveAkashTxWallet({
        environment: "",
        actuatorApiKey: ACTUATOR,
        expectedAccountId: ACCOUNT,
      })
    ).toThrow(/DEPLOY_ENVIRONMENT/);
  });

  it("CANNOT be handed the legacy controller wallet — the input does not exist", () => {
    // The task.5095 shape required BOTH credentials so it could byte-compare them, which meant
    // the actuator held the very wallet it claimed to be isolated from. Assert the surface is
    // gone at the source level, not just unused: a stray `legacyControllerApiKey` property would
    // be silently ignored by the resolver, so a runtime assertion could not catch a regression.
    const source = readFileSync(
      path.join(__dirname, "akash-tx-wallet.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/legacyControllerApiKey/);
    // AKASH_CONSOLE_API_KEY may only appear in prose explaining why it is absent.
    expect(source).not.toMatch(/input\.\w*[Ll]egacy/);
  });
});

describe("assertActuatorWalletAccount", () => {
  it("passes when the live Console account set contains the pinned address", () => {
    expect(() =>
      assertActuatorWalletAccount(ACCOUNT, [
        { accountId: OTHER_ACCOUNT },
        { accountId: ACCOUNT },
      ])
    ).not.toThrow();
  });

  it("REFUSES when the credential opens a different wallet than the one pinned", () => {
    try {
      assertActuatorWalletAccount(ACCOUNT, [{ accountId: OTHER_ACCOUNT }]);
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as AkashTxWalletConfigError).code).toBe(
        "actuator_account_mismatch"
      );
    }
  });

  it("REFUSES an empty observation rather than assuming the wallet is fine", () => {
    try {
      assertActuatorWalletAccount(ACCOUNT, []);
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as AkashTxWalletConfigError).code).toBe(
        "actuator_account_unverifiable"
      );
    }
  });

  it("treats blank observed account ids as no observation at all", () => {
    expect(() =>
      assertActuatorWalletAccount(ACCOUNT, [{ accountId: "   " }])
    ).toThrow(/cannot be confirmed/);
  });

  it("tolerates whitespace around the pinned value from the Deployment env", () => {
    expect(() =>
      assertActuatorWalletAccount(`  ${ACCOUNT}  `, [{ accountId: ACCOUNT }])
    ).not.toThrow();
  });

  it("never leaks a credential in the refusal — only public account ids", () => {
    try {
      assertActuatorWalletAccount(ACCOUNT, [{ accountId: OTHER_ACCOUNT }]);
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as Error).message).not.toContain(ACTUATOR);
      expect((error as Error).message).toContain(OTHER_ACCOUNT);
    }
  });
});

describe("credentialFingerprint (bug.5142)", () => {
  it("is stable, 12 hex, and distinguishes two credential versions", () => {
    const v3 = credentialFingerprint("console-key-v3");
    const v4 = credentialFingerprint("console-key-v4");
    expect(v3).toMatch(/^[0-9a-f]{12}$/);
    expect(v3).toBe(credentialFingerprint("console-key-v3"));
    expect(v3).not.toBe(v4);
  });

  it("returns 'absent' for an empty credential, NOT the digest of the empty string", () => {
    // sha256("") is e3b0c442..., a fixed value that looks exactly like a real fingerprint.
    // Publishing it would invite the false match this function exists to prevent.
    expect(credentialFingerprint("")).toBe("absent");
    expect(credentialFingerprint("")).not.toMatch(/^e3b0c442/);
  });

  it("never reveals the credential", () => {
    const secret = "sk-super-secret-console-key";
    const fp = credentialFingerprint(secret);
    expect(secret).not.toContain(fp);
    expect(fp).not.toContain(secret);
    expect(fp.length).toBe(12);
  });

  it("agrees with the documented shell recipe, including the JSON-quoting trap", () => {
    // The recipe in the docblock is `bao kv get -field=K <path> | tr -d '\r\n' | shasum -a 256`.
    // Two real false readings came from hashing the wrong bytes, so pin both:
    const raw = "console-key-v4";
    const shell = createHash("sha256")
      .update(raw, "utf8")
      .digest("hex")
      .slice(0, 12);
    expect(credentialFingerprint(raw)).toBe(shell);

    // `-format=json -field=` emits a JSON-QUOTED string; hashing that matches nothing.
    expect(credentialFingerprint(JSON.stringify(raw))).not.toBe(shell);
    // A trailing newline (plain `shasum` of the file) likewise disagrees — which is exactly
    // why the recipe pipes through `tr -d '\r\n'`.
    expect(credentialFingerprint(`${raw}\n`)).not.toBe(shell);
  });
});
