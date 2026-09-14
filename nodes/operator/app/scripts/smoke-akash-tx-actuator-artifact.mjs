// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

import { spawnSync } from "node:child_process";

// biome-ignore lint/style/noProcessEnv: one-shot artifact smoke preserves only executable lookup
const path = process.env.PATH ?? "";
const result = spawnSync(
  process.execPath,
  ["dist-akash-tx-actuator/akash-tx-actuator.mjs"],
  {
    encoding: "utf8",
    env: {
      PATH: path,
      NODE_ENV: "production",
    },
  }
);
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
if (
  result.status === 0 ||
  !output.includes("POD_NAMESPACE and DEPLOY_ENVIRONMENT are required") ||
  output.includes("Dynamic require")
) {
  process.stderr.write(output);
  throw new Error(
    "packaged akash-tx actuator did not reach its expected missing-environment guard"
  );
}
process.stdout.write("akash-tx actuator packaged entry loaded successfully\n");
