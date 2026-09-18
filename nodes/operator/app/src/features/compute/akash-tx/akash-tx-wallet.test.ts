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
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { ACCOUNT_WALLET_SCOPE_PATTERN } from "@/shared/db/akash-tx-allocations";

import {
  type AkashTxWalletConfigError,
  accountWalletScope,
  assertActuatorWalletAccount,
  assertLedgerIsAccountScoped,
  credentialFingerprint,
  isAccountWalletScope,
  resolveAkashTxWallet,
} from "./akash-tx-wallet";

const ACTUATOR = "operator-sponsor-console-key";
const ACCOUNT = "akash1operatorsponsorwalletaddress";
const OTHER_ACCOUNT = "akash1someotherwalletaddress";
/** A real-shaped bech32 address — the scope predicate checks the SHAPE, so fixtures must too. */
const REAL_ACCOUNT = "akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l";

describe("resolveAkashTxWallet", () => {
  it("keys the scope on the PINNED ACCOUNT, never on an environment (bug.5187)", () => {
    expect(
      resolveAkashTxWallet({
        actuatorApiKey: ACTUATOR,
        expectedAccountId: ACCOUNT,
      })
    ).toEqual({
      walletScope: `akash-console:${ACCOUNT}`,
      apiKey: ACTUATOR,
      expectedAccountId: ACCOUNT,
    });
  });

  /**
   * THE INVERTED ASSERTION. This used to read "scopes each environment separately so one env's
   * Postgres serializes one env's wallet", and it passed by producing THREE scope strings for
   * three environments on ONE Console account. That is precisely the defect: the serializer is a
   * partial unique index on `(wallet_scope) WHERE state='preparing'`, so three scope values are
   * three slots, and two writers on one account could never collide. The north star makes one
   * account bill test, preview and production alike, so the property to hold is the opposite —
   * one account is ONE ledger domain however many environments its writer serves.
   */
  it("gives ONE scope per account however many environments its writer serves", () => {
    const scopes = ["candidate-a", "preview", "production"].map(
      () =>
        resolveAkashTxWallet({
          actuatorApiKey: ACTUATOR,
          expectedAccountId: ACCOUNT,
        }).walletScope
    );
    expect(new Set(scopes).size).toBe(1);
  });

  it("still separates two accounts — account -> scope stays injective", () => {
    expect(
      resolveAkashTxWallet({
        actuatorApiKey: ACTUATOR,
        expectedAccountId: ACCOUNT,
      }).walletScope
    ).not.toBe(
      resolveAkashTxWallet({
        actuatorApiKey: ACTUATOR,
        expectedAccountId: OTHER_ACCOUNT,
      }).walletScope
    );
  });

  it("derives the scope from the pinned account, not the secret — rotation cannot orphan receipts", () => {
    const before = resolveAkashTxWallet({
      actuatorApiKey: ACTUATOR,
      expectedAccountId: ACCOUNT,
    });
    const after = resolveAkashTxWallet({
      actuatorApiKey: "rotated-console-key",
      expectedAccountId: ACCOUNT,
    });
    expect(after.walletScope).toBe(before.walletScope);
  });

  it("REFUSES a missing credential — there is no fallback to any other wallet", () => {
    try {
      resolveAkashTxWallet({ expectedAccountId: ACCOUNT });
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

  /**
   * The old suite asserted the opposite ("requires an environment — an unscoped ledger
   * serializes nothing"). Under the north star a writer serves environments other than its own,
   * so an `environment` input could only re-introduce the inert per-env scope. Assert the
   * surface is GONE at the source level — same reasoning as the legacy-credential test below: a
   * stray property would be silently ignored by the resolver, so no runtime check could catch it.
   */
  it("CANNOT be handed an environment — the input does not exist (bug.5187)", () => {
    const source = readFileSync(
      path.join(__dirname, "akash-tx-wallet.ts"),
      "utf8"
    );
    expect(source).not.toMatch(/input\.environment/);
    expect(source).not.toMatch(/akash-console:\$\{environment\}/);
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

describe("accountWalletScope / isAccountWalletScope (bug.5187)", () => {
  it("accepts an account-keyed scope and REJECTS every legacy environment-keyed one", () => {
    expect(isAccountWalletScope(accountWalletScope(REAL_ACCOUNT))).toBe(true);
    for (const environment of ["candidate-a", "preview", "production"]) {
      expect(isAccountWalletScope(`akash-console:${environment}`)).toBe(false);
    }
  });

  it("is the SAME predicate the database enforces and the migration installs", () => {
    // ONE literal, three places: the exported constant, the drizzle `check()` the snapshot was
    // generated from, and the committed migration that adds the constraint to live databases.
    // Reading the files is the only way to prove the three agree without a running Postgres.
    const migrationsDir = path.join(
      __dirname,
      "../../../adapters/server/db/migrations"
    );
    const schemaSource = readFileSync(
      path.join(__dirname, "../../../shared/db/akash-tx-allocations.ts"),
      "utf8"
    );
    const migration = readdirSync(migrationsDir)
      .filter((file) => file.endsWith(".sql"))
      .map((file) => readFileSync(path.join(migrationsDir, file), "utf8"))
      .find((sql) =>
        sql.includes("akash_tx_allocations_wallet_scope_account_check")
      );

    expect(schemaSource).toContain(`'${ACCOUNT_WALLET_SCOPE_PATTERN}'`);
    expect(migration).toBeDefined();
    expect(migration).toContain(`~ '${ACCOUNT_WALLET_SCOPE_PATTERN}'`);
  });
});

describe("assertLedgerIsAccountScoped (bug.5187)", () => {
  it("passes on a ledger the backfill has reached", () => {
    expect(() => assertLedgerIsAccountScoped(0)).not.toThrow();
  });

  /**
   * The direction a CHECK constraint cannot cover: a writer pod that starts BEFORE its migrator
   * has run. Its account-keyed lookup cannot see the env-keyed receipts of leases that are still
   * billing, and `claimOnce` treats "no receipt" as "nothing was ever created" — so it would
   * mint a second paid lease beside each. A CrashLoop is the cheap outcome; refuse.
   */
  it("REFUSES to serve while env-keyed receipts remain", () => {
    try {
      assertLedgerIsAccountScoped(5);
      expect.unreachable("must refuse");
    } catch (error) {
      expect((error as AkashTxWalletConfigError).code).toBe(
        "ledger_scope_unmigrated"
      );
      expect((error as Error).message).toContain("second paid lease");
    }
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
