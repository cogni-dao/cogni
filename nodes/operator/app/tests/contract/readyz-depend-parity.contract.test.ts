// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/contract/readyz-depend-parity.contract`
 * Purpose: Drift guard — the operator's deep-readyz registry must cover every substrate dependency its env schema declares (story.0029).
 * Scope: Enumerates `serverSchema.shape` keys matching the substrate pattern and asserts each is owned by a `SUBSTRATE_DEPENDENCIES` entry or allowlisted. Does not perform IO.
 * Invariants: A new `*_URL`/`*_ADDRESS` env key added without a readyz decision fails this test.
 * Side-effects: none
 * Links: src/app/(infra)/readyz/readyz-probes.ts, src/shared/env/server-env.ts
 * @internal
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DeepProbeFailure as PkgDeepProbeFailure } from "@cogni/substrate-health";
import { describe, expect, it } from "vitest";
import {
  buildDeepChecks,
  DeepProbeFailure as LocalDeepProbeFailure,
  findUnclassifiedSubstrateKeys,
  NON_SUBSTRATE_ALLOWLIST,
  SUBSTRATE_DEPENDENCIES,
  SUBSTRATE_ENV_KEY_PATTERN,
} from "@/app/(infra)/readyz/readyz-probes";
import { serverSchema } from "@/shared/env/server-env";

type DeepChecksArgs = Parameters<typeof buildDeepChecks>;
// buildDeepChecks only reads env (via isDeclared) to build the list; the ctx and
// container are never touched until a check runs, so stubs are safe here.
const ctxStub = {} as DeepChecksArgs[0];
const containerStub = {} as DeepChecksArgs[1];
const baseEnv = {
  LITELLM_BASE_URL: "http://litellm:4000",
  LITELLM_MASTER_KEY: "sk",
  REDIS_URL: "redis://localhost:6379",
} as unknown as DeepChecksArgs[2];

function deepDepNames(env: DeepChecksArgs[2]): string[] {
  return buildDeepChecks(ctxStub, containerStub, env).map(([name]) => name);
}

describe("deep readyz ⇄ env-schema parity", () => {
  const schemaKeys = Object.keys(serverSchema.shape);

  it("classifies every substrate env key as a probe, N/A, or allowlisted", () => {
    const unclassified = findUnclassifiedSubstrateKeys(schemaKeys);
    expect(unclassified).toEqual([]);
  });

  it("fails when a new substrate-looking key is wired without a decision", () => {
    expect(
      findUnclassifiedSubstrateKeys([...schemaKeys, "NEW_SERVICE_URL"])
    ).toEqual(["NEW_SERVICE_URL"]);
  });

  it("ignores keys that are not substrate-shaped", () => {
    expect(findUnclassifiedSubstrateKeys(["SOME_FEATURE_FLAG"])).toEqual([]);
  });

  it("does not allowlist a key that a dependency already owns", () => {
    const owned = new Set<string>();
    for (const dep of SUBSTRATE_DEPENDENCIES) {
      for (const key of dep.envKeys) owned.add(key);
    }
    for (const key of NON_SUBSTRATE_ALLOWLIST) {
      expect(owned.has(key)).toBe(false);
      expect(SUBSTRATE_ENV_KEY_PATTERN.test(key)).toBe(true);
    }
  });
});

describe("deep readyz registry config-gate (buildDeepChecks filter)", () => {
  it("omits Doltgres from the deep checks when DOLTGRES_URL is unset", () => {
    // Proves the registry FILTER drops the probe (not the probe's own early
    // return): an unset DOLTGRES_URL means no doltgres entry is even built.
    expect(deepDepNames(baseEnv)).not.toContain("doltgres");
  });

  it("includes Doltgres only when DOLTGRES_URL is declared", () => {
    const withDoltgres = {
      ...baseEnv,
      DOLTGRES_URL: "postgresql://doltgres:5432/knowledge",
    } as DeepChecksArgs[2];
    expect(deepDepNames(withDoltgres)).toContain("doltgres");
  });

  it("always builds the serving-critical probes in registry order", () => {
    // Order fixes `reason`/`message` (first failure) and the `unreachable[]` order.
    expect(deepDepNames(baseEnv)).toEqual([
      "evm-rpc",
      "temporal",
      "scheduler-worker",
      "postgres",
      "redis",
      "litellm-gateway",
    ]);
  });
});

describe("deep readyz renders only from @cogni-dao/substrate-health", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const adapterSrc = readFileSync(
    resolve(here, "../../src/app/(infra)/readyz/readyz-probes.ts"),
    "utf8"
  );

  it("uses the package's DeepProbeFailure by identity (no local copy)", () => {
    expect(LocalDeepProbeFailure).toBe(PkgDeepProbeFailure);
  });

  it("defines no runner or probe logic locally — it lives in the package", () => {
    // The concurrent runner, the catalog fetch and the failure class live in
    // @cogni-dao/substrate-health; the adapter only wires operator ports and closures.
    expect(adapterSrc).not.toMatch(/Promise\.all(Settled)?\b/);
    expect(adapterSrc).not.toContain("/model/info");
    expect(adapterSrc).not.toMatch(/class\s+DeepProbeFailure/);
  });
});
