// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import type {
  AppCredentialVerification,
  StoredAppCredentialPair,
} from "@/ports";
import {
  type AppCredentialBindingPolicy,
  decideCustodyWrite,
  decideHealth,
  decidePostWriteConclusion,
  decideStagedPairAdmission,
} from "./app-credential-rotation";

const FP_NEW = "a".repeat(64);
const FP_OLD = "b".repeat(64);

const POLICY: AppCredentialBindingPolicy = {
  env: "candidate-a",
  expectedAppId: "3956976",
  expectedWebhookHost: "test.cognidao.org",
  expectedInstallationOwner: "cogni-test-org",
};

const VERIFIED: AppCredentialVerification = {
  kind: "verified",
  appId: "3956976",
  appSlug: "cogni-operator-test",
  webhookHost: "test.cognidao.org",
  installationOwners: ["cogni-test-org"],
};

const STORED_OLD: StoredAppCredentialPair = {
  configured: true,
  appId: "3956976",
  privateKeyFingerprint: FP_OLD,
  version: 7,
};

describe("decideStagedPairAdmission", () => {
  it("admits a verified, correctly bound staged pair", () => {
    expect(
      decideStagedPairAdmission({
        stagedAppId: "3956976",
        stagedFingerprint: FP_NEW,
        verification: VERIFIED,
        policy: POLICY,
      })
    ).toEqual({ admit: true, reasons: [] });
  });

  it("refuses unparseable staged material as invalid", () => {
    const d = decideStagedPairAdmission({
      stagedAppId: "3956976",
      stagedFingerprint: null,
      verification: VERIFIED,
      policy: POLICY,
    });
    expect(d).toMatchObject({ admit: false, conclusion: "invalid" });
  });

  it("refuses GitHub-rejected credentials as invalid (401 / foreign key)", () => {
    for (const reason of [
      "unauthenticated",
      "identity_mismatch",
      "invalid_key_material",
    ] as const) {
      const d = decideStagedPairAdmission({
        stagedAppId: "3956976",
        stagedFingerprint: FP_NEW,
        verification: { kind: "invalid", reason },
        policy: POLICY,
      });
      expect(d).toMatchObject({
        admit: false,
        conclusion: "invalid",
        reasons: [`github_${reason}`],
      });
    }
  });

  it("maps transport failure to failed — never invalid, never success (C2)", () => {
    const d = decideStagedPairAdmission({
      stagedAppId: "3956976",
      stagedFingerprint: FP_NEW,
      verification: { kind: "transport_failure", status: 502 },
      policy: POLICY,
    });
    expect(d).toMatchObject({
      admit: false,
      conclusion: "failed",
      reasons: ["github_transport_failure_status_502"],
    });
  });

  it("refuses when server-owned policy is inexpressible → unconfigured", () => {
    const d = decideStagedPairAdmission({
      stagedAppId: "3956976",
      stagedFingerprint: FP_NEW,
      verification: VERIFIED,
      policy: {
        env: "candidate-a",
        expectedAppId: undefined,
        expectedWebhookHost: undefined,
        expectedInstallationOwner: undefined,
      },
    });
    expect(d).toMatchObject({ admit: false, conclusion: "unconfigured" });
    expect(d.reasons).toEqual([
      "expected_app_id_unset",
      "expected_webhook_host_unset",
      "expected_installation_owner_unset",
    ]);
  });

  it.each([
    [
      "wrong App identity",
      { ...VERIFIED, appId: "1111111" },
      "1111111",
      "staged_app_id_differs_from_expected_app",
    ],
    [
      "wrong webhook host",
      { ...VERIFIED, webhookHost: "evil.example.com" },
      "3956976",
      "webhook_host_differs_from_env_host",
    ],
    [
      "no installation on the expected owner",
      { ...VERIFIED, installationOwners: ["someone-else"] },
      "3956976",
      "no_installation_on_expected_owner",
    ],
  ] as const)("refuses a misbound pair: %s", (_name, verification, stagedAppId, reason) => {
    const d = decideStagedPairAdmission({
      stagedAppId,
      stagedFingerprint: FP_NEW,
      verification,
      policy: POLICY,
    });
    expect(d).toMatchObject({ admit: false, conclusion: "misbound" });
    expect(d.reasons).toContain(reason);
  });
});

describe("decideCustodyWrite (idempotence)", () => {
  it("full no-op when custody AND live consumer already hold the staged pair → current", () => {
    expect(
      decideCustodyWrite({
        stagedAppId: "3956976",
        stagedFingerprint: FP_NEW,
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: { appId: "3956976", privateKeyFingerprint: FP_NEW },
      })
    ).toMatchObject({ shouldWrite: false, conclusion: "current" });
  });

  it("custody matches but the pod lags → written_not_propagated, and NO second write", () => {
    expect(
      decideCustodyWrite({
        stagedAppId: "3956976",
        stagedFingerprint: FP_NEW,
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: { appId: "3956976", privateKeyFingerprint: FP_OLD },
      })
    ).toMatchObject({
      shouldWrite: false,
      conclusion: "written_not_propagated",
    });
  });

  it("writes when custody differs — including an unparseable stored key", () => {
    expect(
      decideCustodyWrite({
        stagedAppId: "3956976",
        stagedFingerprint: FP_NEW,
        stored: STORED_OLD,
        live: { appId: "3956976", privateKeyFingerprint: FP_OLD },
      })
    ).toMatchObject({ shouldWrite: true });
    expect(
      decideCustodyWrite({
        stagedAppId: "3956976",
        stagedFingerprint: FP_NEW,
        stored: {
          configured: true,
          appId: "3956976",
          privateKeyUnparseable: true,
          version: 3,
        },
        live: { appId: "3956976", privateKeyFingerprint: FP_OLD },
      })
    ).toMatchObject({ shouldWrite: true });
  });
});

describe("decidePostWriteConclusion (C2: written is not rotated)", () => {
  it("a 200 write with a lagging pod is written_not_propagated, never rotated", () => {
    expect(
      decidePostWriteConclusion({
        stagedFingerprint: FP_NEW,
        live: { appId: "3956976", privateKeyFingerprint: FP_OLD },
      })
    ).toBe("written_not_propagated");
  });

  it("rotated only when the live consumer demonstrably holds the staged key", () => {
    expect(
      decidePostWriteConclusion({
        stagedFingerprint: FP_NEW,
        live: { appId: "3956976", privateKeyFingerprint: FP_NEW },
      })
    ).toBe("rotated");
  });
});

describe("decideHealth (C3: the recurring divergence verdict)", () => {
  const LIVE_NEW = { appId: "3956976", privateKeyFingerprint: FP_NEW };

  it("current when custody == live consumer, GitHub-valid, correctly bound", () => {
    expect(
      decideHealth({
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: LIVE_NEW,
        verification: VERIFIED,
        policy: POLICY,
      })
    ).toEqual({ conclusion: "current", reasons: [] });
  });

  it("unconfigured when the OpenBao pair is absent", () => {
    expect(
      decideHealth({
        stored: { configured: false, version: 0 },
        live: LIVE_NEW,
        verification: null,
        policy: POLICY,
      })
    ).toMatchObject({ conclusion: "unconfigured" });
  });

  it("invalid when GitHub rejects the stored credential — the 2026-10-03 silent class, made loud", () => {
    expect(
      decideHealth({
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: LIVE_NEW,
        verification: { kind: "invalid", reason: "unauthenticated" },
        policy: POLICY,
      })
    ).toMatchObject({
      conclusion: "invalid",
      reasons: ["github_unauthenticated"],
    });
  });

  it("written_not_propagated when the pod has not converged on custody (ESO/Reloader lag)", () => {
    expect(
      decideHealth({
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: { appId: "3956976", privateKeyFingerprint: FP_OLD },
        verification: null,
        policy: POLICY,
      })
    ).toMatchObject({ conclusion: "written_not_propagated" });
  });

  it("misbound when the verified App violates env binding policy", () => {
    expect(
      decideHealth({
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: LIVE_NEW,
        verification: { ...VERIFIED, webhookHost: "evil.example.com" },
        policy: POLICY,
      })
    ).toMatchObject({ conclusion: "misbound" });
  });

  it("failed on transport failure and on an unverifiable stored pair — never green", () => {
    expect(
      decideHealth({
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: LIVE_NEW,
        verification: { kind: "transport_failure" },
        policy: POLICY,
      })
    ).toMatchObject({ conclusion: "failed" });
    expect(
      decideHealth({
        stored: { ...STORED_OLD, privateKeyFingerprint: FP_NEW },
        live: LIVE_NEW,
        verification: null,
        policy: POLICY,
      })
    ).toMatchObject({ conclusion: "failed" });
  });

  it("invalid when the stored material itself is unparseable", () => {
    expect(
      decideHealth({
        stored: {
          configured: true,
          appId: "3956976",
          privateKeyUnparseable: true,
          version: 4,
        },
        live: LIVE_NEW,
        verification: null,
        policy: POLICY,
      })
    ).toMatchObject({ conclusion: "invalid" });
  });
});
