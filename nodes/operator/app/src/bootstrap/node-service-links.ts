// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@bootstrap/node-service-links`
 * Purpose: Composition root for the operator's node service links (story.0038): wires the link store,
 *   the enrollment signer and transport, the sealed-key crypto and the connection writer into the link
 *   service.
 * Scope: Dependency wiring only. Returns null when the vault key or the signing key is not configured, so
 *   callers answer 503 `node_service_links_unavailable` instead of throwing.
 * Invariants:
 *   - NO_NEW_SECRET: reuses CONNECTIONS_ENCRYPTION_KEY (vault) and IDENTITY_ATTESTATION_PRIVATE_KEY
 *     (signing); nothing else is introduced.
 *   - ISSUER_IS_THE_OPERATOR_ORIGIN: `iss` is the canonical origin of APP_BASE_URL, the same issuer X
 *     trusts for GitHub attestations (default trusted home).
 * Side-effects: none at import time; singletons are created lazily on first use.
 * Links: src/features/node-service-links/service.ts, story.0038
 * @public
 */

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  DrizzleNodeServiceLinkStore,
  DrizzleServiceConnectionWriter,
  HttpNodeEnrollmentTransport,
  JoseServiceEnrollmentSigner,
  JoseServiceKeyCrypto,
} from "@/adapters/server";
import { createOperatorDeployPlane } from "@/bootstrap/capabilities/operator-deploy-plane";
import { createReviewGithubPlane } from "@/bootstrap/review/resolve-review-route";
import {
  createNodeServiceLinkService,
  type NodeServiceLinkService,
} from "@/features/node-service-links/service";
import { serverEnv } from "@/shared/env";
import { importAttestationSigningKey } from "@/shared/identity/attestation-keys";
import { makeLogger } from "@/shared/observability";
import { resolveAppDb, resolveServiceDb } from "./container";

let cached: NodeServiceLinkService | null | undefined;

/** The operator's link service, or null when its vault or signing key is not configured. */
export function getNodeServiceLinkService(): NodeServiceLinkService | null {
  if (cached !== undefined) return cached;
  const env = serverEnv();
  const log = makeLogger({ component: "node-service-links" });
  if (
    !env.CONNECTIONS_ENCRYPTION_KEY ||
    !env.IDENTITY_ATTESTATION_PRIVATE_KEY
  ) {
    cached = null;
    return cached;
  }
  const keyBuf = Buffer.from(env.CONNECTIONS_ENCRYPTION_KEY, "hex");
  let issuer: string;
  let signingKey: ReturnType<typeof importAttestationSigningKey>;
  try {
    if (keyBuf.length !== 32) throw new Error("connections_key_length");
    issuer = new URL(env.APP_BASE_URL ?? "").origin;
    signingKey = importAttestationSigningKey(
      env.IDENTITY_ATTESTATION_PRIVATE_KEY
    );
  } catch {
    cached = null;
    return cached;
  }
  cached = createNodeServiceLinkService({
    store: new DrizzleNodeServiceLinkStore({
      db: resolveServiceDb(),
      encryptionKey: keyBuf,
      encryptionKeyId: "v1",
    }),
    signer: new JoseServiceEnrollmentSigner(signingKey),
    transport: new HttpNodeEnrollmentTransport(),
    crypto: new JoseServiceKeyCrypto(),
    connections: new DrizzleServiceConnectionWriter({
      db: resolveAppDb() as unknown as import("drizzle-orm/node-postgres").NodePgDatabase,
      encryptionKey: keyBuf,
      encryptionKeyId: "v1",
    }),
    issuer,
    now: () => new Date(),
    newId: randomUUID,
    log,
  });
  return cached;
}

/**
 * `githubReady` of a link answer: the review App is installed on node X's repository, so a review can
 * post its check. False when X's repo cannot be resolved or the App is absent (the App is the operator's
 * existing `cogni-operator`; no node gets a new GitHub credential).
 */
export async function resolveGithubReady(
  slug: string,
  log: Logger
): Promise<boolean> {
  const env = serverEnv();
  const plane = createReviewGithubPlane(log);
  if (
    !plane ||
    !env.NODE_SUBMODULE_PARENT_OWNER ||
    !env.NODE_SUBMODULE_PARENT_REPO
  ) {
    return false;
  }
  try {
    const repo = await createOperatorDeployPlane(env).resolveNodeRepo({
      parentOwner: env.NODE_SUBMODULE_PARENT_OWNER,
      parentRepo: env.NODE_SUBMODULE_PARENT_REPO,
      slug,
    });
    return await plane.isReviewAppInstalled({
      owner: repo.owner,
      repo: repo.repo,
    });
  } catch {
    return false;
  }
}
