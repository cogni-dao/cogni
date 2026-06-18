// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  isNodeOwnedSecretKey,
  SUBSTRATE_RESERVED_KEYS,
} from "./node-secrets-reserved.data";

describe("node-secrets reserved-key guard (gate 2)", () => {
  it("allows any node-owned app key, including brand-new ones", () => {
    expect(isNodeOwnedSecretKey("X_OAUTH_CLIENT_ID")).toBe(true);
    expect(isNodeOwnedSecretKey("X_OAUTH_CLIENT_SECRET")).toBe(true);
    expect(isNodeOwnedSecretKey("X_API_BEARER_TOKEN")).toBe(true);
    expect(isNodeOwnedSecretKey("SOME_BRAND_NEW_VENDOR_KEY")).toBe(true);
  });

  it("refuses substrate-managed keys (DB creds / DSNs / auth)", () => {
    expect(isNodeOwnedSecretKey("APP_DB_PASSWORD")).toBe(false);
    expect(isNodeOwnedSecretKey("DATABASE_URL")).toBe(false);
    expect(isNodeOwnedSecretKey("DOLTGRES_URL")).toBe(false);
    expect(isNodeOwnedSecretKey("AUTH_SECRET")).toBe(false);
    expect(isNodeOwnedSecretKey("POSTGRES_ROOT_PASSWORD")).toBe(false);
  });

  it("refuses per-node agent-minted identity / crypto-at-rest keys (clobber = data loss)", () => {
    // Regression: these are `source: agent` keys materialized into the node's
    // own path. They were absent from the denylist, which let a self-serve
    // write clobber CONNECTIONS_ENCRYPTION_KEY on prod beacon. They must mirror
    // secret-materialize.sh's key_is_agent_generated set.
    expect(isNodeOwnedSecretKey("CONNECTIONS_ENCRYPTION_KEY")).toBe(false);
    expect(isNodeOwnedSecretKey("INTERNAL_OPS_TOKEN")).toBe(false);
    expect(isNodeOwnedSecretKey("METRICS_TOKEN")).toBe(false);
    expect(isNodeOwnedSecretKey("GH_WEBHOOK_SECRET")).toBe(false);
    expect(isNodeOwnedSecretKey("POLY_WALLET_AEAD_KEY_HEX")).toBe(false);
  });

  it("the reserved set is a denylist (small + fixed), not a per-node allowlist", () => {
    // Denylist invariant: a key absent from the set is allowed by default.
    expect(SUBSTRATE_RESERVED_KEYS.has("X_OAUTH_CLIENT_ID")).toBe(false);
    expect(isNodeOwnedSecretKey("ANYTHING_NOT_RESERVED")).toBe(true);
  });
});
