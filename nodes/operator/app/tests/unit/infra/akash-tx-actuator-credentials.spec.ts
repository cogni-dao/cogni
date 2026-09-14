// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@tests/unit/infra/akash-tx-actuator-credentials.spec`
 * Purpose: Keep the actuator's credential refusal DIAGNOSABLE. The process already fails
 *   closed with a named first-party reason for each projected credential; a non-optional
 *   projected Secret source silently defeats that by stopping the container from ever
 *   running, leaving only a kubelet `FailedMount` event that is not in Loki.
 * Scope: Reads the committed base Deployment as YAML. Asserts nothing about OpenBao, ESO,
 *   or runtime behaviour — only the manifest property that decides WHICH failure surface
 *   the operator sees.
 * Invariants:
 *   - REFUSAL_IS_OWNED_BY_THE_PROCESS: the app decides whether to serve, so every
 *     credential source is `optional: true`. Security is unchanged (the process still
 *     refuses and never listens); only the diagnosis moves from an invisible kubelet
 *     event to a log line naming the missing credential.
 *   - EVERY_PROJECTED_KEY_HAS_A_NAMED_REFUSAL: a key mounted here must be one the boot
 *     path explicitly refuses on, otherwise its absence is silent in a different way.
 * Side-effects: IO (reads infra/k8s/base at test time)
 * Links: infra/k8s/base/akash-tx-actuator/deployment.yaml,
 *   src/bootstrap/akash-tx-actuator.ts
 * @public
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/** Walk up to the repo root so the test survives being moved. */
function repoRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 12; i++) {
    if (existsSync(join(dir, "infra/k8s/base/akash-tx-actuator"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("repo root not found above the test file");
}

const read = (relative: string): string =>
  readFileSync(join(repoRoot(), relative), "utf8");

interface ProjectedSecretSource {
  secret?: {
    name?: string;
    optional?: boolean;
    items?: { key?: string; path?: string }[];
  };
}

function credentialSources(): ProjectedSecretSource[] {
  const deployment = parse(
    read("infra/k8s/base/akash-tx-actuator/deployment.yaml")
  ) as {
    spec?: {
      template?: {
        spec?: {
          volumes?: {
            name?: string;
            projected?: { sources?: ProjectedSecretSource[] };
          }[];
        };
      };
    };
  };
  const volume = deployment.spec?.template?.spec?.volumes?.find(
    (candidate) => candidate.name === "akash-tx-credentials"
  );
  expect(volume, "akash-tx-credentials volume must exist").toBeDefined();
  return volume?.projected?.sources ?? [];
}

describe("akash-tx-actuator projected credentials", () => {
  it("projects every credential the boot path refuses on", () => {
    // Guards the guard: an empty parse would make the optionality assertion vacuous.
    const keys = credentialSources()
      .flatMap((source) => source.secret?.items ?? [])
      .map((item) => item.key)
      .sort();
    expect(keys).toEqual([
      "AKASH_ACTUATOR_CONSOLE_API_KEY",
      "AKASH_TX_ACTUATOR_TOKEN",
      "DATABASE_URL",
    ]);
  });

  it("marks every source optional so the process — not kubelet — owns the refusal", () => {
    // kubelet refuses to mount a projected Secret whose object OR whose listed `key` is
    // absent, so a non-optional source keeps the pod in ContainerCreating and the
    // container never runs. That makes `akash_tx_actuator_wallet_unresolved`,
    // `akash_tx_actuator_token_missing` and `akash_tx_actuator_ledger_dsn_missing`
    // unreachable in exactly the case they exist for — the cutover window where the
    // Console key has not been minted yet. Optional keeps the refusal and restores the log.
    const nonOptional = credentialSources()
      .filter((source) => source.secret?.optional !== true)
      .map((source) => source.secret?.name);
    expect(nonOptional).toEqual([]);
  });
});
