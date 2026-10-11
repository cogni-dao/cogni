// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@bootstrap/capabilities/operator-app-credentials`
 * Purpose: Factory for the platform-owned GitHub App credential rotation plane
 *   (subtask.5016). Mirrors `createOperatorSecretsPlane`: reads env, throws
 *   (→ route 503) when the pod's OpenBao writer identity is not provisioned.
 * Scope: Wires the OpenBao pair-custody adapter (projected SA-token reader) and
 *   the read-only GitHub identity adapter. No shared-node stub — only the
 *   operator exposes the rotation route.
 * Side-effects: none at construction (the SA-token file is read per call).
 * Links: src/ports/operator-app-credentials.port.ts,
 *   src/adapters/server/secrets/openbao-app-credentials.adapter.ts,
 *   src/adapters/server/secrets/github-app-identity.adapter.ts
 * @internal
 */

import { readFile } from "node:fs/promises";
import {
  GithubAppIdentityAdapter,
  OpenBaoAppCredentialsAdapter,
} from "@/adapters/server";
import type {
  GithubAppIdentityPort,
  OperatorAppCredentialsStorePort,
} from "@/ports";
import type { ServerEnv } from "@/shared/env";

export interface OperatorAppCredentialsPlane {
  readonly store: OperatorAppCredentialsStorePort;
  readonly github: GithubAppIdentityPort;
}

export function createOperatorAppCredentialsPlane(
  env: ServerEnv
): OperatorAppCredentialsPlane {
  if (!env.OPENBAO_NODE_SECRETS_WRITER_ROLE) {
    throw new Error(
      "operator not configured for secrets plane: OPENBAO_NODE_SECRETS_WRITER_ROLE required (provision the operator-secrets-writer SA + role first)"
    );
  }
  const tokenPath = env.OPENBAO_SA_TOKEN_PATH;
  return {
    store: new OpenBaoAppCredentialsAdapter({
      addr: env.OPENBAO_ADDR,
      role: env.OPENBAO_NODE_SECRETS_WRITER_ROLE,
      readServiceAccountToken: async () =>
        (await readFile(tokenPath, "utf-8")).trim(),
    }),
    github: new GithubAppIdentityAdapter(),
  };
}
