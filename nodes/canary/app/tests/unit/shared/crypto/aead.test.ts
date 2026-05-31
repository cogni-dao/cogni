import { randomBytes } from "node:crypto";
import { type AeadAAD, aeadDecrypt, aeadEncrypt } from "@cogni/node-shared";
import { describe, expect, it } from "vitest";

const KEY = randomBytes(32);
const AAD: AeadAAD = {
  billing_account_id: "ba_123",
  connection_id: "conn_456",
  provider: "openai-chatgpt",
};

describe("AEAD encrypt/decrypt", () => {
  it("roundtrips plaintext correctly", () => {
    const plaintext = JSON.stringify({
      access_token: "sk-test-token",
      refresh_token: "rt-test-token",
      account_id: "acc-789",
    });
    const ciphertext = aeadEncrypt(plaintext, AAD, KEY);
    const decrypted = aeadDecrypt(ciphertext, AAD, KEY);
    expect(decrypted).toBe(plaintext);
  });

  it("produces different ciphertexts for same input (random nonce)", () => {
    const plaintext = "test-data";
    const c1 = aeadEncrypt(plaintext, AAD, KEY);
    const c2 = aeadEncrypt(plaintext, AAD, KEY);
    expect(c1.equals(c2)).toBe(false);
  });

  it("fails with wrong key", () => {
    const plaintext = "secret";
    const ciphertext = aeadEncrypt(plaintext, AAD, KEY);
    const wrongKey = randomBytes(32);
    expect(() => aeadDecrypt(ciphertext, AAD, wrongKey)).toThrow();
  });

  it("fails with wrong AAD (tenant rebind attack)", () => {
    const plaintext = "secret";
    const ciphertext = aeadEncrypt(plaintext, AAD, KEY);
    const wrongAAD: AeadAAD = {
      billing_account_id: "ba_ATTACKER",
      connection_id: "conn_456",
      provider: "openai-chatgpt",
    };
    expect(() => aeadDecrypt(ciphertext, wrongAAD, KEY)).toThrow();
  });

  it("fails with tampered ciphertext", () => {
    const plaintext = "secret";
    const ciphertext = aeadEncrypt(plaintext, AAD, KEY);
    // Flip a byte in the encrypted portion
    ciphertext[15] ^= 0xff;
    expect(() => aeadDecrypt(ciphertext, AAD, KEY)).toThrow();
  });

  it("fails with too-short ciphertext", () => {
    expect(() => aeadDecrypt(Buffer.from("short"), AAD, KEY)).toThrow(
      "AEAD ciphertext too short"
    );
  });
});
