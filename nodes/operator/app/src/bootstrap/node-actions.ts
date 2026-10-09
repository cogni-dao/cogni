// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Composition root for the operator-authorized node action gateway. */

import { type KeyObject, randomUUID } from "node:crypto";

import { IdentityAttestationOriginSchema } from "@cogni/node-contracts";

import { HttpNodeActionAdapter, JoseNodeActionSigner } from "@/adapters/server";
import { getContainer } from "@/bootstrap/container";
import { serverEnv } from "@/shared/env";
import { importAttestationSigningKey } from "@/shared/identity/attestation-keys";

export class NodeActionUnavailableError extends Error {
  constructor() {
    super("node_action_unavailable");
    this.name = "NodeActionUnavailableError";
  }
}

export function resolveNodeActionDependencies() {
  const env = serverEnv();
  const issuer = IdentityAttestationOriginSchema.safeParse(env.APP_BASE_URL);
  if (
    !issuer.success ||
    !env.IDENTITY_ATTESTATION_PRIVATE_KEY ||
    !env.DEPLOY_ENVIRONMENT
  ) {
    throw new NodeActionUnavailableError();
  }

  let signingKey: KeyObject;
  try {
    signingKey = importAttestationSigningKey(
      env.IDENTITY_ATTESTATION_PRIVATE_KEY
    );
  } catch {
    throw new NodeActionUnavailableError();
  }

  const container = getContainer();
  return {
    issuer: issuer.data,
    environment: env.DEPLOY_ENVIRONMENT,
    gatewayDeps: {
      authorization: container.authorization,
      signer: new JoseNodeActionSigner(signingKey),
      nodeAddress: container.nodeAddress,
      http: new HttpNodeActionAdapter(),
      clock: container.clock,
      createJti: randomUUID,
    },
  };
}
