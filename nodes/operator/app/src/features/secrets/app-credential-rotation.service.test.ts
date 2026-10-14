// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  AppCredentialVerification,
  GithubAppIdentityPort,
  OperatorAppCredentialsStorePort,
  StoredAppCredentialPair,
} from "@/ports";
import type { ServerEnv } from "@/shared/env";
import { fingerprintAppPrivateKeyBase64 } from "@/shared/secrets/github-app-key-fingerprint";
import {
  evaluateOperatorAppCredentialHealth,
  rotateOperatorAppCredential,
} from "./app-credential-rotation.service";

function keyB64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return Buffer.from(pem, "utf-8").toString("base64");
}

const NEW_KEY = keyB64();
const OLD_KEY = keyB64();
const NEW_FP = (() => {
  const r = fingerprintAppPrivateKeyBase64(NEW_KEY);
  if (!r.ok) throw new Error("fixture");
  return r.fingerprint;
})();
const OLD_FP = (() => {
  const r = fingerprintAppPrivateKeyBase64(OLD_KEY);
  if (!r.ok) throw new Error("fixture");
  return r.fingerprint;
})();

const APP_ID = "3956976";

const VERIFIED: AppCredentialVerification = {
  kind: "verified",
  appId: APP_ID,
  appSlug: "cogni-operator-test",
  webhookHost: "test.cognidao.org",
  installationOwners: ["cogni-test-org"],
};

// The pod's own (live-consumer) credential = the OLD key pre-rotation.
const ENV = {
  DEPLOY_ENVIRONMENT: "candidate-a",
  GH_REVIEW_APP_ID: APP_ID,
  GH_REVIEW_APP_PRIVATE_KEY_BASE64: OLD_KEY,
  APP_BASE_URL: "https://test.cognidao.org",
  NODE_SUBMODULE_PARENT_OWNER: "cogni-test-org",
} as unknown as ServerEnv;

function makeStore(
  stored: StoredAppCredentialPair
): OperatorAppCredentialsStorePort & {
  writes: unknown[];
} {
  const writes: unknown[] = [];
  return {
    writes,
    readStoredAppCredentialPair: vi.fn(async () => stored),
    writeAppCredentialPair: vi.fn(async (input) => {
      writes.push(input);
      return { version: stored.version + 1 };
    }),
  };
}

function makeGithub(
  verification: AppCredentialVerification
): GithubAppIdentityPort {
  return { verifyAppCredential: vi.fn(async () => verification) };
}

const STORED_OLD: StoredAppCredentialPair = {
  configured: true,
  appId: APP_ID,
  privateKeyFingerprint: OLD_FP,
  version: 7,
};

describe("rotateOperatorAppCredential", () => {
  it("admits, writes atomically at the observed version, and reports written_not_propagated (C2/C4)", async () => {
    const store = makeStore(STORED_OLD);
    const report = await rotateOperatorAppCredential(
      { store, github: makeGithub(VERIFIED), env: ENV },
      { appId: APP_ID, privateKeyBase64: NEW_KEY }
    );
    expect(report.conclusion).toBe("written_not_propagated");
    expect(report.kvVersion).toBe(8);
    expect(store.writes).toEqual([
      {
        env: "candidate-a", // server-stamped, the caller never supplied an env
        appId: APP_ID,
        privateKeyBase64: NEW_KEY,
        expectedVersion: 7, // CAS at the version the read observed
      },
    ]);
    // The wire/log-safe report never contains key material.
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(NEW_KEY.slice(0, 24));
    expect(serialized).not.toContain(OLD_KEY.slice(0, 24));
    expect(report.staged?.keyFingerprint).toBe(NEW_FP);
    expect(report.liveConsumer?.keyFingerprint).toBe(OLD_FP);
  });

  it("is idempotent: custody already holding the staged pair never writes again", async () => {
    const store = makeStore({ ...STORED_OLD, privateKeyFingerprint: NEW_FP });
    const report = await rotateOperatorAppCredential(
      { store, github: makeGithub(VERIFIED), env: ENV },
      { appId: APP_ID, privateKeyBase64: NEW_KEY }
    );
    expect(report.conclusion).toBe("written_not_propagated"); // pod still on OLD_KEY
    expect(store.writes).toEqual([]);
  });

  it("reports current on a full no-op (custody and pod both hold the staged key)", async () => {
    const env = {
      ...ENV,
      GH_REVIEW_APP_PRIVATE_KEY_BASE64: NEW_KEY,
    } as unknown as ServerEnv;
    const store = makeStore({ ...STORED_OLD, privateKeyFingerprint: NEW_FP });
    const report = await rotateOperatorAppCredential(
      { store, github: makeGithub(VERIFIED), env },
      { appId: APP_ID, privateKeyBase64: NEW_KEY }
    );
    expect(report.conclusion).toBe("current");
    expect(store.writes).toEqual([]);
  });

  it("never writes on invalid or misbound staged pairs (never-green-on-invalid)", async () => {
    const invalidStore = makeStore(STORED_OLD);
    const invalid = await rotateOperatorAppCredential(
      {
        store: invalidStore,
        github: makeGithub({ kind: "invalid", reason: "unauthenticated" }),
        env: ENV,
      },
      { appId: APP_ID, privateKeyBase64: NEW_KEY }
    );
    expect(invalid.conclusion).toBe("invalid");
    expect(invalidStore.writes).toEqual([]);

    const misboundStore = makeStore(STORED_OLD);
    const misbound = await rotateOperatorAppCredential(
      {
        store: misboundStore,
        github: makeGithub({ ...VERIFIED, webhookHost: "evil.example.com" }),
        env: ENV,
      },
      { appId: APP_ID, privateKeyBase64: NEW_KEY }
    );
    expect(misbound.conclusion).toBe("misbound");
    expect(misbound.reasons).toContain("webhook_host_differs_from_env_host");
    expect(misboundStore.writes).toEqual([]);
  });

  it("maps a CAS conflict / OpenBao failure to failed with the typed code", async () => {
    const store = makeStore(STORED_OLD);
    store.writeAppCredentialPair = vi.fn(async () => {
      throw Object.assign(new Error("openbao_cas_conflict (status 400)"), {
        code: "openbao_cas_conflict",
        status: 400,
      });
    });
    const report = await rotateOperatorAppCredential(
      { store, github: makeGithub(VERIFIED), env: ENV },
      { appId: APP_ID, privateKeyBase64: NEW_KEY }
    );
    expect(report.conclusion).toBe("failed");
    expect(report.reasons).toEqual(["openbao_cas_conflict"]);
  });

  it("refuses an unparseable staged key before any IO", async () => {
    const store = makeStore(STORED_OLD);
    const github = makeGithub(VERIFIED);
    const report = await rotateOperatorAppCredential(
      { store, github, env: ENV },
      {
        appId: APP_ID,
        privateKeyBase64: Buffer.from("junk").toString("base64"),
      }
    );
    expect(report.conclusion).toBe("invalid");
    expect(store.readStoredAppCredentialPair).not.toHaveBeenCalled();
    expect(github.verifyAppCredential).not.toHaveBeenCalled();
  });
});

describe("evaluateOperatorAppCredentialHealth", () => {
  it("reports current when custody, pod, and GitHub all agree", async () => {
    const env = {
      ...ENV,
      GH_REVIEW_APP_PRIVATE_KEY_BASE64: NEW_KEY,
    } as unknown as ServerEnv;
    const report = await evaluateOperatorAppCredentialHealth({
      store: makeStore({ ...STORED_OLD, privateKeyFingerprint: NEW_FP }),
      github: makeGithub(VERIFIED),
      env,
    });
    expect(report.conclusion).toBe("current");
    expect(report.bankCustody).toBe("unobservable");
  });

  it("surfaces the revoked-stored-key class as invalid (the 2026-10-03 silent window)", async () => {
    const env = {
      ...ENV,
      GH_REVIEW_APP_PRIVATE_KEY_BASE64: NEW_KEY,
    } as unknown as ServerEnv;
    const report = await evaluateOperatorAppCredentialHealth({
      store: makeStore({ ...STORED_OLD, privateKeyFingerprint: NEW_FP }),
      github: makeGithub({ kind: "invalid", reason: "unauthenticated" }),
      env,
    });
    expect(report.conclusion).toBe("invalid");
  });

  it("surfaces custody-vs-pod divergence as written_not_propagated without needing GitHub", async () => {
    const github = makeGithub(VERIFIED);
    const report = await evaluateOperatorAppCredentialHealth({
      store: makeStore({ ...STORED_OLD, privateKeyFingerprint: NEW_FP }),
      github,
      env: ENV, // pod holds OLD_KEY
    });
    expect(report.conclusion).toBe("written_not_propagated");
    expect(github.verifyAppCredential).not.toHaveBeenCalled();
  });

  it("maps an OpenBao read failure to failed — never green", async () => {
    const store = makeStore(STORED_OLD);
    store.readStoredAppCredentialPair = vi.fn(async () => {
      throw Object.assign(new Error("openbao_read_failed (status 503)"), {
        code: "openbao_read_failed",
      });
    });
    const report = await evaluateOperatorAppCredentialHealth({
      store,
      github: makeGithub(VERIFIED),
      env: ENV,
    });
    expect(report.conclusion).toBe("failed");
    expect(report.reasons).toEqual(["openbao_read_failed"]);
  });
});
