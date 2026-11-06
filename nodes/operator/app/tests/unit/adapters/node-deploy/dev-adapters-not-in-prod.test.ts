// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@tests/unit/adapters/node-deploy/dev-adapters-not-in-prod`
 * Purpose: ConsolePayer (pays straight from a Console key) and FileStatePasswords must be unreachable
 *   from the production sequencer bootstrap, so they can never be bundled into the image (task.5400).
 * Side-effects: filesystem reads
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const app = path.resolve(__dirname, "../../../..");
/** Source with comments removed: the rule is about CODE reachability, not prose that names the dev adapter. */
const read = (relative: string) =>
  readFileSync(path.join(app, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .replace(/(^|[^:])\/\/[^\n]*/gu, "$1");

describe("dev-only node-deploy adapters", () => {
  it("are not exported from the @/adapters/server barrel", () => {
    const barrel = read("src/adapters/server/index.ts");
    expect(barrel).not.toMatch(/ConsolePayer|console-payer/u);
    expect(barrel).not.toMatch(/FileStatePasswords/u);
    expect(barrel).toMatch(/KubernetesStatePasswords/u);
  });

  it("are not imported by the production bootstrap or any non-harness source", () => {
    const bootstrap = read("src/bootstrap/node-deploy-sequencer.ts");
    expect(bootstrap).not.toMatch(
      /ConsolePayer|console-payer|FileStatePasswords/u
    );
    expect(bootstrap).toMatch(/ActuatorPayer/u);
    // the harness is the ONLY importer, by path
    const harness = read("scripts/node-deploy-local.ts");
    expect(harness).toMatch(
      /adapters\/server\/node-deploy\/console-payer\.adapter/u
    );
  });
});
