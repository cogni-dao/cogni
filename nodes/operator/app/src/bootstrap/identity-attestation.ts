// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Composition factory for identity-attestation persistence and signing ports. */

import { type KeyObject, randomUUID } from "node:crypto";

import {
  JoseIdentityAttestationSigner,
  OperatorIdentityAttestationRepository,
} from "@/adapters/server";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { getContainer, resolveAppDb } from "@/bootstrap/container";
import { serverEnv } from "@/shared/env/server-env";

export function resolveIdentityAttestationDependencies(signingKey: KeyObject) {
  const env = serverEnv();
  const parentOwner = env.NODE_SUBMODULE_PARENT_OWNER;
  const parentRepo = env.NODE_SUBMODULE_PARENT_REPO;
  if (!parentOwner || !parentRepo) {
    throw new Error(
      "identity attestation requires NODE_SUBMODULE_PARENT_OWNER + NODE_SUBMODULE_PARENT_REPO"
    );
  }
  return {
    repository: new OperatorIdentityAttestationRepository(
      resolveAppDb(),
      createOperatorDeployPlane(env),
      { parentOwner, parentRepo }
    ),
    signer: new JoseIdentityAttestationSigner(signingKey),
    clock: getContainer().clock,
    createJti: randomUUID,
  };
}
