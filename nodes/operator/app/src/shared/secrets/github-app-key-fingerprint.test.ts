// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  decodeAppPrivateKeyPem,
  fingerprintAppPrivateKeyBase64,
} from "./github-app-key-fingerprint";

function freshKeyBase64(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  return Buffer.from(pem, "utf-8").toString("base64");
}

describe("fingerprintAppPrivateKeyBase64", () => {
  it("derives a stable public-key sha256 hex fingerprint", () => {
    const keyB64 = freshKeyBase64();
    const a = fingerprintAppPrivateKeyBase64(keyB64);
    const b = fingerprintAppPrivateKeyBase64(keyB64);
    expect(a.ok).toBe(true);
    expect(b).toEqual(a);
    if (a.ok) {
      expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      // The fingerprint must not embed any fragment of the material.
      expect(keyB64).not.toContain(a.fingerprint);
    }
  });

  it("two different keys produce different fingerprints", () => {
    const a = fingerprintAppPrivateKeyBase64(freshKeyBase64());
    const b = fingerprintAppPrivateKeyBase64(freshKeyBase64());
    expect(a.ok && b.ok && a.fingerprint !== b.fingerprint).toBe(true);
  });

  it("refuses empty and non-key input with typed reasons, never material echoes", () => {
    expect(fingerprintAppPrivateKeyBase64("")).toEqual({
      ok: false,
      reason: "empty",
    });
    const garbage = Buffer.from("not a pem at all", "utf-8").toString("base64");
    expect(fingerprintAppPrivateKeyBase64(garbage)).toEqual({
      ok: false,
      reason: "invalid_key_material",
    });
  });
});

describe("decodeAppPrivateKeyPem", () => {
  it("round-trips a valid key and nulls everything else", () => {
    const keyB64 = freshKeyBase64();
    expect(decodeAppPrivateKeyPem(keyB64)).toContain("PRIVATE KEY");
    expect(decodeAppPrivateKeyPem("")).toBeNull();
    expect(
      decodeAppPrivateKeyPem(Buffer.from("junk").toString("base64"))
    ).toBeNull();
  });
});
