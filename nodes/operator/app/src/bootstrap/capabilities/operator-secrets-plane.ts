// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/operator-secrets-plane`
 * Purpose: Factory for the operator-local secrets plane port. Mirrors
 *   createOperatorDeployPlane: reads env, throws (→ 503) when the writer identity
 *   is not provisioned. No shared-node stub — non-operator nodes do not expose the route.
 * Scope: Reads env + wires the OpenBao adapter (incl. the projected SA-token reader).
 * Side-effects: none at construction (the SA-token file is read per write call).
 * Links: src/ports/operator-secrets-plane.port.ts,
 *   src/adapters/server/secrets/openbao-secrets.adapter.ts
 * @internal
 */

import { readFile } from "node:fs/promises";
import { OpenBaoSecretsAdapter } from "@/adapters/server";
import type { OperatorSecretsPlanePort } from "@/ports";
import type { ServerEnv } from "@/shared/env";

export function createOperatorSecretsPlane(
  env: ServerEnv
): OperatorSecretsPlanePort {
  if (!env.OPENBAO_NODE_SECRETS_WRITER_ROLE) {
    throw new Error(
      "operator not configured for secrets plane: OPENBAO_NODE_SECRETS_WRITER_ROLE required (provision the operator-secrets-writer SA + role first — candidate-a only today)"
    );
  }
  const tokenPath = env.OPENBAO_SA_TOKEN_PATH;
  return new OpenBaoSecretsAdapter({
    addr: env.OPENBAO_ADDR,
    role: env.OPENBAO_NODE_SECRETS_WRITER_ROLE,
    readServiceAccountToken: async () =>
      (await readFile(tokenPath, "utf-8")).trim(),
  });
}
