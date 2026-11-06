// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/identity/attest/confirm`
 * Purpose: The account-intent gate. Shows which GitHub account GitHub authenticated and
 *   which node is asking, and requires a deliberate click before anything is signed.
 * Scope: Renders the broker cookie's resolved state. Signs nothing.
 * Invariants:
 *   - INTENT_IS_EXPLICIT: `prompt=select_account` forces GitHub's picker but does NOT
 *     prove intent — it cannot force credential re-entry and is undocumented for the
 *     zero/one-account case. This screen is the only thing that proves the human meant
 *     THIS account for THIS node (task.5024).
 *   - NO_SILENT_ISSUANCE: no auto-submit, no redirect-on-render.
 *   - ONE_QUESTION: the screen asks "this account, this node?" and shows nothing that
 *     does not help answer it. Prose here is a bug — a human under a security prompt
 *     reads the identity and the verb, nothing else.
 * Side-effects: IO (cookie read)
 * @public
 */

import { cookies } from "next/headers";

import { authSecret } from "@/auth";
import { PageContainer, SectionCard } from "@/components";
import { ATTESTATION_SIGNIN_PATH } from "@/shared/identity/broker-config";
import {
  BROKER_STATE_COOKIE,
  consentBinding,
  decodeBrokerState,
} from "@/shared/identity/broker-state";

import { ConfirmActions } from "./actions";

export const dynamic = "force-dynamic";

export default async function IdentityAttestationConfirmPage() {
  const cookieStore = await cookies();
  const token = cookieStore.get(BROKER_STATE_COOKIE)?.value;
  const brokerState = await decodeBrokerState(token, authSecret);

  if (!brokerState?.github || !token) {
    return (
      <PageContainer maxWidth="sm">
        <SectionCard title="This request expired">
          <p className="text-muted-foreground text-sm">
            Start again from the node&apos;s profile. Nothing was shared.
          </p>
        </SectionCard>
      </PageContainer>
    );
  }

  const { github, nodeSlug, returnTo, targetOrigin } = brokerState;
  const login = github.login ? `@${github.login}` : `id ${github.id}`;
  // The node picks its landing path, and the two paths mean different things: the
  // sign-in leg lands on the public completion page, the link leg on /profile. That is
  // the only signal for which verb this human is actually looking at.
  const mode: "signin" | "link" = returnTo.endsWith(ATTESTATION_SIGNIN_PATH)
    ? "signin"
    : "link";

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      {/* Deliberately NOT the operator app shell. Someone signing in to a node has no
          operator account and must not be shown one — no sidebar, no treasury, no admin.
          This is a Cogni identity page, not the operator product. */}
      <p className="font-semibold text-muted-foreground text-sm uppercase tracking-widest">
        Cogni
      </p>

      {/* Three lines, because a human under a security prompt reads the identity, the
          destination, and the verb — nothing else. GitHub can name the account; only we
          can name the node they are entering. That sentence is this page's whole job. */}
      <div className="space-y-2 text-center">
        <p className="font-semibold text-3xl tracking-tight">{login}</p>
        <p className="text-muted-foreground">
          {mode === "signin" ? (
            <>
              Sign in to <span className="text-foreground">{nodeSlug}</span>.
            </>
          ) : (
            <>
              Link GitHub {login} to your existing account on{" "}
              <span className="text-foreground">{nodeSlug}</span>.
            </>
          )}
        </p>
      </div>

      <ConfirmActions mode={mode} consentBinding={consentBinding(token)} />
      {mode === "link" ? (
        <a
          href={`${targetOrigin}/profile`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm underline"
        >
          View your profile on {nodeSlug}
        </a>
      ) : null}

      <p className="text-muted-foreground text-xs">
        Only your public GitHub identity is shared.
      </p>
    </main>
  );
}
