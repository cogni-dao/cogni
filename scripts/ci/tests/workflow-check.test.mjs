// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@scripts/ci/tests/workflow-check`
 * Purpose: Prove dispatch credentials cannot enter runner-rendered workflow fields.
 * Scope: Runs the workflow checker against isolated workflow fixtures.
 * Invariants: Rejects sensitive run/env/with interpolation, including aggregate and dynamic input access.
 * Side-effects: IO (temporary fixture files and child processes)
 * Links: scripts/ci/workflow-check.mjs
 * @internal
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { stringify } from "yaml";

test("workflow policy rejects dispatch secrets before runner preambles", () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-secrets-"));
  try {
    mkdirSync(join(root, ".github"));
    cpSync(".github/workflows", join(root, ".github/workflows"), {
      recursive: true,
    });
    const check = (step) => {
      writeFileSync(
        join(root, ".github/workflows/secret-regression.yml"),
        stringify({
          on: {
            workflow_dispatch: {
              inputs: { password: { type: "string" }, env: { type: "string" } },
            },
          },
          jobs: { probe: { "runs-on": "ubuntu-latest", steps: [step] } },
        })
      );
      return spawnSync(
        process.execPath,
        [resolve("scripts/ci/workflow-check.mjs")],
        { cwd: root, encoding: "utf8" }
      );
    };

    for (const expression of [
      "inputs.password",
      "github.event.inputs['password']",
      "inputs [ 'password' ]",
      "INPUTS.PASSWORD",
      "toJSON(inputs)",
      "inputs[format('{0}', 'password')]",
      "github['event']['inputs']['password']",
    ]) {
      for (const location of ["run", "env", "with"]) {
        const reference = `\${{ ${expression} }}`;
        const step =
          location === "run"
            ? { run: `echo ${reference}` }
            : { run: "true", [location]: { PASSWORD: reference } };
        const result = check(step);
        assert.equal(result.status, 1, `${location}: ${expression}`);
        assert.match(result.stderr, /interpolates sensitive input/);
      }
    }

    const runtimeRead = check({
      env: { DEPLOY_ENV: `\${{ inputs.env }}` },
      run: `jq -r '"::add-mask::" + (.inputs.password // "")' "$GITHUB_EVENT_PATH"`,
    });
    assert.equal(runtimeRead.status, 0, runtimeRead.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
