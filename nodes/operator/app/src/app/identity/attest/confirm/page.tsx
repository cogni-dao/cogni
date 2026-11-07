// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/**
 * Module: `@app/identity/attest/confirm`
 * Purpose: The account-intent gate. Shows which GitHub account GitHub authenticated and
 *   which node account receives it, and requires a deliberate click before anything is signed.
 * Scope: Renders the broker cookie's resolved state. Signs nothing.
 * Invariants:
 *   - INTENT_IS_EXPLICIT: `prompt=select_account` forces GitHub's picker but does NOT
 *     prove intent — it cannot force credential re-entry and is undocumented for the
 *     zero/one-account case. This screen is the only thing that proves the human meant
 *     THIS account for THIS node (task.5024).
 *   - NO_SILENT_ISSUANCE: no auto-submit, no redirect-on-render.
 *   - ONE_QUESTION: the screen asks "this GitHub account, into this node account?" and shows
 *     nothing that does not help answer it.
 *   - BRAND_NEVER_GATES: the node mark is decoration from the public registry; a registry
 *     failure falls back to a monogram and never blocks the gate.
 * Side-effects: IO (cookie read, cached node registry read)
 * @public
 */

import { cookies } from "next/headers";
import Image from "next/image";
import type { ComponentProps, ReactElement } from "react";

import { authSecret } from "@/auth";
import { resolveNodeRegistry } from "@/bootstrap/container";
import { PageContainer, SectionCard } from "@/components";
import { NodeBrandMark } from "@/features/nodes/components/NodeBrandMark";
import { ATTESTATION_SIGNIN_PATH } from "@/shared/identity/broker-config";
import {
  BROKER_STATE_COOKIE,
  consentBinding,
  decodeBrokerState,
} from "@/shared/identity/broker-state";

import { ConfirmActions } from "./actions";

export const dynamic = "force-dynamic";

type NodeBrand = ComponentProps<typeof NodeBrandMark>["node"];

function titleCase(slug: string): string {
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

async function nodeBrand(slug: string): Promise<NodeBrand> {
  try {
    const node = (await resolveNodeRegistry().listPublic()).find(
      (n) => n.slug === slug
    );
    if (node) {
      return {
        title: node.title,
        icon: node.icon ?? null,
        thumbnailUrl: node.thumbnailUrl ?? null,
        brandColor: node.brandColor ?? null,
      };
    }
  } catch {
    // BRAND_NEVER_GATES
  }
  return {
    title: titleCase(slug),
    icon: null,
    thumbnailUrl: null,
    brandColor: null,
  };
}

function Row({
  mark,
  title,
  detail,
}: {
  mark: ReactElement;
  title: string;
  detail: ReactElement | string;
}) {
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      {mark}
      <div className="min-w-0 text-left">
        <p className="truncate font-medium">{title}</p>
        <p className="truncate text-muted-foreground text-xs">{detail}</p>
      </div>
    </li>
  );
}

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
  // The node picks its landing path: the sign-in leg lands on the public completion page,
  // the link leg on /profile. That is the only signal for which verb this human sees.
  const mode: "signin" | "link" = returnTo.endsWith(ATTESTATION_SIGNIN_PATH)
    ? "signin"
    : "link";
  const node = await nodeBrand(nodeSlug);
  const host = new URL(targetOrigin).host;

  return (
    // Deliberately NOT the operator app shell: someone entering a node has no operator
    // account and must not be shown one. This is a Cogni identity page.
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 rounded-2xl border bg-card p-8 text-center shadow-sm">
        <div className="flex items-center gap-3" aria-hidden="true">
          <Image
            src="/TransparentBrainOnly.png"
            alt=""
            width={48}
            height={48}
            className="size-12"
          />
          <span className="text-muted-foreground">⇄</span>
          <NodeBrandMark node={node} className="size-12 rounded-xl" />
        </div>

        <h1 className="font-semibold text-xl tracking-tight">
          {mode === "signin"
            ? `Sign in to ${node.title} with GitHub`
            : `Link GitHub to your ${node.title} account`}
        </h1>

        <ul className="w-full divide-y rounded-xl border text-sm">
          <Row
            mark={
              // biome-ignore lint/performance/noImgElement: GitHub-hosted avatar; next/image remote config not warranted for one 40px mark.
              <img
                src={`https://avatars.githubusercontent.com/u/${github.id}?s=80`}
                alt=""
                className="size-10 shrink-0 rounded-full border bg-muted"
              />
            }
            title={login}
            detail="GitHub account"
          />
          <Row
            mark={<NodeBrandMark node={node} className="size-10" />}
            title={
              mode === "signin" ? node.title : `Your ${node.title} account`
            }
            detail={
              mode === "signin" ? (
                host
              ) : (
                <a
                  href={`${targetOrigin}/profile`}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`View your profile on ${host}`}
                  className="underline underline-offset-2"
                >
                  {host} ↗
                </a>
              )
            }
          />
        </ul>

        <ConfirmActions mode={mode} consentBinding={consentBinding(token)} />

        <p className="text-muted-foreground text-xs">
          {node.title} sees only your public GitHub username and ID.
        </p>
      </div>
    </main>
  );
}
