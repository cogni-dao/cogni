// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/(app)/identity/attest`
 * Purpose: Authenticated operator broker for a node-initiated GitHub binding import.
 * Scope: Validates protocol + node_id + nonce + target_origin, delegates canonical return validation
 *   and issuance, then redirects the browser with the JWT in the fragment.
 * Invariants: Proxy/session auth required; never redirects an invalid return_to.
 * Side-effects: IO (session + attestation issuance)
 * @public
 */

import { IdentityAttestationRequestSchema } from "@cogni/node-contracts";
import { redirect } from "next/navigation";
import {
  AttestationBrokerError,
  issueBrowserIdentityAttestation,
} from "@/app/_facades/identity/attestation-broker.server";
import { getServerSessionUser } from "@/lib/auth/server";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function one(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function BrokerFailure({ code }: { code: string }) {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="font-semibold text-xl">
        GitHub verification could not continue
      </h1>
      <p className="mt-3 text-muted-foreground text-sm">
        The node verification request was rejected ({code}). Return to the node
        and start again from your profile.
      </p>
    </main>
  );
}

export default async function IdentityAttestationBrokerPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const query = await searchParams;
  const request = IdentityAttestationRequestSchema.safeParse({
    protocol: one(query.protocol),
    nodeId: one(query.node_id),
    nonce: one(query.nonce),
    targetOrigin: one(query.target_origin),
  });
  const returnTo = one(query.return_to);
  if (!request.success || !returnTo) {
    return <BrokerFailure code="invalid_request" />;
  }

  const sessionUser = await getServerSessionUser();
  if (!sessionUser) {
    const callback = new URLSearchParams({
      signIn: "1",
      callbackUrl: `/identity/attest?${new URLSearchParams({
        protocol: request.data.protocol,
        node_id: request.data.nodeId,
        nonce: request.data.nonce,
        target_origin: request.data.targetOrigin,
        return_to: returnTo,
      })}`,
    });
    redirect(`/?${callback}`);
  }

  try {
    const result = await issueBrowserIdentityAttestation({
      sessionUser,
      request: request.data,
      returnTo,
    });
    redirect(result.redirectUrl);
  } catch (error) {
    if (error instanceof AttestationBrokerError) {
      return <BrokerFailure code={error.code} />;
    }
    throw error;
  }
}
