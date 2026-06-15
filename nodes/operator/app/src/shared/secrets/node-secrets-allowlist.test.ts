// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  isNodeSecretAllowed,
  NODE_SECRETS_ALLOWLIST,
} from "./node-secrets-allowlist.data";

describe("node-secrets allowlist (gate 2)", () => {
  it("is empty post node-purge — no surviving node self-serves an A2 secret yet", () => {
    // Codegen from the catalog (Invariant 14) seeds this once a minted node
    // declares an A2 key; until then the load-bearing behaviour is fail-closed.
    expect(Object.keys(NODE_SECRETS_ALLOWLIST)).toEqual([]);
  });

  it("fail-closes for every slug + key (no default bucket)", () => {
    expect(isNodeSecretAllowed("operator", "NODE_MINT_OWNER")).toBe(false);
    expect(isNodeSecretAllowed("scheduler-worker", "ANYTHING")).toBe(false);
    expect(isNodeSecretAllowed("does-not-exist", "X")).toBe(false);
    expect(isNodeSecretAllowed("", "X")).toBe(false);
  });

  it("never lists a reserved/shared namespace as a slug", () => {
    expect(Object.keys(NODE_SECRETS_ALLOWLIST)).not.toContain("_system");
    expect(Object.keys(NODE_SECRETS_ALLOWLIST)).not.toContain("_shared");
  });
});
