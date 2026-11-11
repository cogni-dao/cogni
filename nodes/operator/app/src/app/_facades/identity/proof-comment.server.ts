// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/_facades/identity/proof-comment.server`
 * Purpose: Wires the proof-comment policy service (task.0095) to the operator's config, registry, GitHub App reader and signing key.
 * Scope: Builds ONE process-wide service (its 45 second cache and single-flight map must outlive a request) and maps a missing config to a
 *   refusal code. Does not parse HTTP and does not log (the route owns the terminal event).
 * Invariants:
 *   - SAME_KEY_OWN_TYPE: the identity broker's Ed25519 key signs the answer, through `signProofComment` with its own `typ` and claim type.
 *   - FAIL_CLOSED: a missing GitHub App, parent owner, issuer or key is a 503 refusal, never an unsigned or partial answer.
 * Side-effects: IO (registry read, GitHub read), process-local cache
 * @public
 */

import type { GithubCommentAttestationRequest } from "@cogni/node-contracts";
import { resolveBrokerConfig } from "@/app/_facades/identity/attestation-broker.server";
import {
  ProofCommentConfigError,
  resolveProofCommentDependencies,
} from "@/bootstrap/proof-comment";
import {
  createProofCommentService,
  type ProofCommentObserver,
  type ProofCommentOutcome,
  type ProofCommentService,
} from "@/features/identity/services/read-proof-comment";

let service: ProofCommentService | null = null;

function resolveService(): ProofCommentService {
  if (service) return service;
  let broker: ReturnType<typeof resolveBrokerConfig>;
  try {
    broker = resolveBrokerConfig();
  } catch {
    throw new ProofCommentConfigError("signing_unavailable");
  }
  service = createProofCommentService(
    resolveProofCommentDependencies({
      signingKey: broker.signingKey,
      issuer: broker.issuer,
    })
  );
  return service;
}

export async function issueProofCommentAttestation(
  request: GithubCommentAttestationRequest,
  observe: ProofCommentObserver
): Promise<ProofCommentOutcome> {
  try {
    return await resolveService().read(request, observe);
  } catch (error) {
    if (error instanceof ProofCommentConfigError)
      return { ok: false, code: error.code };
    // An unexpected read failure is "no evidence", never a signed guess.
    return { ok: false, code: "github_unavailable" };
  }
}
