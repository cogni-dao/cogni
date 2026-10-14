// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

// biome-ignore lint/style/noProcessEnv: one-shot artifact smoke preserves only executable lookup
const path = process.env.PATH ?? "";
const result = spawnSync(
  process.execPath,
  ["dist-database-reliability-actuator/database-reliability-actuator.mjs"],
  { encoding: "utf8", env: { PATH: path, NODE_ENV: "production" } }
);
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
if (
  result.status === 0 ||
  !output.includes("database_reliability_missing_env:DEPLOY_ENVIRONMENT") ||
  output.includes("Dynamic require")
) {
  process.stderr.write(output);
  throw new Error(
    "packaged database reliability actuator did not reach its expected missing-environment guard"
  );
}

const missingSha = spawnSync(
  process.execPath,
  ["dist-database-reliability-actuator/database-reliability-actuator.mjs"],
  {
    encoding: "utf8",
    env: {
      PATH: path,
      NODE_ENV: "production",
      DEPLOY_ENVIRONMENT: "candidate-a",
    },
  }
);
const missingShaOutput = `${missingSha.stdout ?? ""}\n${missingSha.stderr ?? ""}`;
if (
  missingSha.status === 0 ||
  !missingShaOutput.includes("database_reliability_missing_env:APP_BUILD_SHA")
) {
  process.stderr.write(missingShaOutput);
  throw new Error("packaged actuator did not require an immutable build SHA");
}

const invalidSha = spawnSync(
  process.execPath,
  ["dist-database-reliability-actuator/database-reliability-actuator.mjs"],
  {
    encoding: "utf8",
    env: {
      PATH: path,
      NODE_ENV: "production",
      DEPLOY_ENVIRONMENT: "candidate-a",
      APP_BUILD_SHA: "main",
    },
  }
);
const invalidShaOutput = `${invalidSha.stdout ?? ""}\n${invalidSha.stderr ?? ""}`;
if (
  invalidSha.status === 0 ||
  !invalidShaOutput.includes("database_reliability_build_sha_invalid")
) {
  process.stderr.write(invalidShaOutput);
  throw new Error("packaged actuator accepted a mutable catalog ref");
}

const artifact = readFileSync(
  "dist-database-reliability-actuator/database-reliability-actuator.mjs",
  "utf8"
);
if (artifact.includes('sourceRef: "main"')) {
  throw new Error("packaged actuator contains a mutable main catalog fallback");
}
process.stdout.write(
  "database reliability actuator packaged entry loaded successfully\n"
);
