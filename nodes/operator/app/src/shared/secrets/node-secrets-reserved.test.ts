// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { describe, expect, it } from "vitest";
import {
  EXTERNAL_WORKLOAD_DENIED_KEYS,
  isExternalWorkloadSecretKey,
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
    expect(isNodeOwnedSecretKey("LITELLM_VIRTUAL_KEY")).toBe(false);
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

describe("external-workload secret boundary (gate 3, provenance-keyed)", () => {
  it("allows format-valid node-owned keys without an operator allowlist", () => {
    expect(isExternalWorkloadSecretKey("SOME_BRAND_NEW_VENDOR_KEY")).toBe(true);
    expect(isExternalWorkloadSecretKey("AUTH_SECRET")).toBe(true);
    expect(isExternalWorkloadSecretKey("DATABASE_URL")).toBe(true);
    expect(isExternalWorkloadSecretKey("LITELLM_VIRTUAL_KEY")).toBe(true);
  });

  it.each([
    // bug.5093 regression. Every key here is minted FOR ONE NODE and lives only
    // at cogni/<env>/<node>/<KEY> — blast radius is that node. They were
    // name-listed as denied, which contradicted this module's own stated rule
    // and made poly (which carries its own per-tenant custody creds) permanently
    // undeployable to Akash: buildComputeSecretResources hard-throws on any
    // denied ref. Sensitivity is not provenance; the node's OpenBao namespace
    // is the authority.
    "POLY_WALLET_AEAD_KEY_HEX",
    "POLY_WALLET_AEAD_KEY_ID",
    "PRIVY_APP_ID",
    "PRIVY_APP_SECRET",
    "PRIVY_SIGNING_KEY",
    "PRIVY_USER_WALLETS_APP_SECRET",
    "PRIVY_USER_WALLETS_SIGNING_KEY",
    "DISCORD_BOT_TOKEN",
  ])("allows node-owned key %s — sensitivity is not provenance", (key) => {
    expect(isExternalWorkloadSecretKey(key)).toBe(true);
    expect(EXTERNAL_WORKLOAD_DENIED_KEYS.has(key)).toBe(false);
  });

  it("names no NODE: every denied key is operator/fleet/substrate-owned", () => {
    // Shared platform code must not enumerate a particular NODE's secrets.
    // Naming a shared SERVICE the operator owns is NOT a callout — DOLTHUB and
    // LITELLM are fleet services (`tier: A1, service: _shared`), one value
    // fanned to every node, owned by no node. So this guard bans node-owned
    // prefixes only, and explicitly allow-lists the fleet-shared group.
    const nodeOwnedPrefixes = ["POLY_", "PRIVY_", "DISCORD_"];
    const offenders = [...EXTERNAL_WORKLOAD_DENIED_KEYS].filter((key) =>
      nodeOwnedPrefixes.some((prefix) => key.startsWith(prefix))
    );
    expect(offenders).toEqual([]);
  });

  it.each([
    // Fleet-shared (`service: _shared`) — ONE DoltHub credential across the
    // whole fleet, structurally identical to LITELLM_MASTER_KEY. No node owns
    // or needs these, so they must not reach a rented multi-tenant provider.
    "DOLTHUB_API_TOKEN",
    "DOLT_CREDS_JWK",
    "DOLT_CREDS_KEYID",
    "DOLTHUB_OAUTH_CLIENT_ID",
    "DOLTHUB_OAUTH_CLIENT_SECRET",
  ])("denies fleet-shared DoltHub credential %s", (key) => {
    expect(isExternalWorkloadSecretKey(key)).toBe(false);
  });

  it("still allows DOLTHUB_OWNER — an org name, not a credential", () => {
    // Deliberately NOT restored: `_shared`, but it carries no authorization.
    expect(isExternalWorkloadSecretKey("DOLTHUB_OWNER")).toBe(true);
  });

  it.each([
    // Denied because the OPERATOR/SUBSTRATE mints, rotates, or fleet-shares the
    // value — one copy authorizes action beyond the node carrying it.
    "LITELLM_MASTER_KEY", // one key authenticates the whole fleet to the proxy
    "OPENROUTER_API_KEY",
    "AKASH_CONSOLE_API_KEY",
    "CLOUDFLARE_API_TOKEN",
    "GH_REVIEW_APP_PRIVATE_KEY_BASE64",
    "GH_GRAFANA_PARENT_SA_TOKEN",
    "IDENTITY_ATTESTATION_PRIVATE_KEY", // signs every node's attestation
    "APP_DB_PASSWORD",
    "POSTGRES_ROOT_PASSWORD",
    "TEMPORAL_DB_PASSWORD",
    "GHCR_DEPLOY_TOKEN",
    "ACTIONS_AUTOMATION_BOT_PAT",
  ])("denies operator/fleet/substrate-owned key %s", (key) => {
    expect(isExternalWorkloadSecretKey(key)).toBe(false);
  });

  it.each([
    "",
    "lowercase",
    "NOT-SHELL-SAFE",
    "0_STARTS_WITH_DIGIT",
  ])("denies malformed logical key %s", (key) => {
    expect(isExternalWorkloadSecretKey(key)).toBe(false);
  });
});
