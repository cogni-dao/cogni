// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@cogni/operator-wallet/port/cosmos-signer`
 * Purpose: Cosmos signer port — narrow, typed interface for raw-digest secp256k1 signing used by Cosmos-SDK chains (SIGN_MODE_DIRECT signs sha256(SignDoc bytes)).
 * Scope: Defines the signer interface + domain error types. Does not implement custody logic, hold key material, or build transactions.
 * Invariants:
 *   - KEY_NEVER_IN_APP — implementations never expose raw private key material.
 *   - DIGEST_ONLY — the only signable input is a 32-byte digest; no message/typed-data surface.
 *   - LOW_S_SIGNATURES — signatures are 64-byte `r||s` with low-s normalization
 *     (Cosmos SDK rejects malleable high-s signatures).
 * Side-effects: none (interface definition only)
 * Links: https://node-template.cognidao.org/knowledge/operator-wallet-custody-boundary, work item task.5060 (story.5017 Track B)
 * @public
 */

/**
 * Signer-agnostic seam for Cosmos-chain custody: everything downstream of key
 * custody (address derivation, SignDoc build, TxRaw assembly, broadcast) is
 * identical whether the key lives in Privy, an OpenBao plugin, or a local test key.
 *
 * Proven end-to-end on live akashnet-2 by the task.5059 spike.
 */
export interface CosmosSignerPort {
  /** Return the 33-byte compressed secp256k1 public key. */
  getPublicKey(): Promise<Uint8Array>;

  /**
   * Sign a 32-byte digest (sha256 of SignDoc bytes for SIGN_MODE_DIRECT).
   *
   * @param digest - exactly 32 bytes
   * @returns 64-byte `r||s` signature with low-s normalization
   * @throws {InvalidDigestError} when the digest is not 32 bytes
   * @throws {SignatureFormatError} when the backend returns an unusable signature
   * @throws {SignerRequestError} when the signing backend request fails
   */
  signDigest(digest: Uint8Array): Promise<Uint8Array>;
}

/** Base class for all Cosmos signer domain errors. */
export class CosmosSignerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/** The caller supplied a digest that is not exactly 32 bytes. */
export class InvalidDigestError extends CosmosSignerError {
  constructor(message: string) {
    super("INVALID_DIGEST", message);
  }
}

/** A signature or public key could not be parsed into the expected shape. */
export class SignatureFormatError extends CosmosSignerError {
  constructor(message: string) {
    super("SIGNATURE_FORMAT", message);
  }
}

/**
 * A signing-backend request failed. Messages are constructed from status codes
 * and static labels only — never from raw responses or credential material.
 */
export class SignerRequestError extends CosmosSignerError {
  /** HTTP status code, when the failure was an HTTP error response. */
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super("SIGNER_REQUEST_FAILED", message);
    this.status = status;
  }
}

/** Type guard for {@link CosmosSignerError} and its subclasses. */
export function isCosmosSignerError(
  error: unknown
): error is CosmosSignerError {
  return error instanceof CosmosSignerError;
}
