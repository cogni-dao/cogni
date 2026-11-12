// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import { assertEvmRpcConfig, assertRuntimeSecrets } from "./invariants";
import { serverEnv } from "./server-env";

/** Validate local configuration without constructing providers or calling dependencies. */
export function localReadinessPreflight() {
  const env = serverEnv();
  assertRuntimeSecrets(env);
  assertEvmRpcConfig(env);
  return env;
}
