// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  isNodeSecretAllowed,
  NODE_SECRETS_ALLOWLIST,
} from "./node-secrets-allowlist.data";

describe("node-secrets allowlist (gate 2)", () => {
  it("allows a declared A2 key for its own node slug", () => {
    expect(isNodeSecretAllowed("poly", "POLYGON_RPC_URL")).toBe(true);
    expect(isNodeSecretAllowed("poly", "POLY_WALLET_AEAD_KEY_HEX")).toBe(true);
  });

  it("refuses an undeclared key on a known slug (fail-closed, not defaulted)", () => {
    expect(isNodeSecretAllowed("poly", "POSTGRES_ROOT_PASSWORD")).toBe(false);
    expect(isNodeSecretAllowed("poly", "MADE_UP_KEY")).toBe(false);
  });

  it("refuses cross-pollination: a key declared for another slug", () => {
    // POLYGON_RPC_URL belongs to poly; operator must not be able to set it.
    expect(isNodeSecretAllowed("operator", "POLYGON_RPC_URL")).toBe(false);
    // NODE_MINT_OWNER belongs to operator; poly must not be able to set it.
    expect(isNodeSecretAllowed("poly", "NODE_MINT_OWNER")).toBe(false);
  });

  it("refuses an unknown slug entirely (no default bucket)", () => {
    expect(isNodeSecretAllowed("does-not-exist", "POLYGON_RPC_URL")).toBe(false);
    expect(isNodeSecretAllowed("", "POLYGON_RPC_URL")).toBe(false);
  });

  it("never lists a reserved/shared namespace as a slug", () => {
    expect(Object.keys(NODE_SECRETS_ALLOWLIST)).not.toContain("_system");
    expect(Object.keys(NODE_SECRETS_ALLOWLIST)).not.toContain("_shared");
  });
});
