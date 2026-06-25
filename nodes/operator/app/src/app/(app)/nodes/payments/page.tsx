// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/nodes/payments/page`
 * Purpose: Server entrypoint for payment activation. Sources the operator-wallet + DAO addresses
 *   from either (a) the `nodes` registry row when invoked with `?nodeId=...` (external-node wizard),
 *   or (b) the local `.cogni/repo-spec.yaml` (legacy monorepo flow).
 * Scope: Reads input source; delegates wallet interaction to the client component.
 * Invariants: REPO_SPEC_FALLBACK — legacy flow without `?nodeId` keeps its original behavior.
 * Side-effects: IO (filesystem read of repo-spec OR Postgres read of nodes row)
 * Links: docs/spec/node-formation.md, task.5083
 * @public
 */

import { withTenantScope } from "@cogni/db-client";
import { type UserId, userActor } from "@cogni/ids";
import { getDaoUrl } from "@cogni/node-shared";
import { and, eq } from "drizzle-orm";
import type { ReactElement } from "react";

import { resolveAppDb } from "@/bootstrap/container";
import { nodeRepoUrlForSlug } from "@/features/nodes/launch-pack";
import { getServerSessionUser } from "@/lib/auth/server";
import {
  getDaoTreasuryAddress,
  getOperatorWalletConfig,
} from "@/shared/config";
import { nodes } from "@/shared/db/nodes";
import { serverEnv } from "@/shared/env";

import { PaymentActivationPageClient } from "./PaymentActivationPage.client";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface PageProps {
  searchParams: Promise<{ nodeId?: string }>;
}

export default async function PaymentActivationPage({
  searchParams,
}: PageProps): Promise<ReactElement> {
  const sp = await searchParams;
  const nodeId = sp.nodeId ?? null;

  if (nodeId) {
    const session = await getServerSessionUser();
    if (session) {
      const db = resolveAppDb();
      const rows = await withTenantScope(
        db,
        userActor(session.id as UserId),
        async (tx) =>
          tx
            .select()
            .from(nodes)
            .where(and(eq(nodes.id, nodeId), eq(nodes.ownerUserId, session.id)))
            .limit(1)
      );
      const node = rows[0];
      if (node) {
        const env = serverEnv();
        const nodeRepoUrl = nodeRepoUrlForSlug({
          slug: node.slug,
          mintOwner: env.NODE_MINT_OWNER,
          publishPrUrl: node.publishPrUrl,
        });
        const repoSpecUrl = nodeRepoUrl
          ? `${nodeRepoUrl}/blob/main/.cogni/repo-spec.yaml`
          : null;
        const daoUrl =
          node.daoAddress && node.chainId
            ? getDaoUrl(node.chainId, node.daoAddress)
            : null;
        return (
          <PaymentActivationPageClient
            operatorWalletAddress={node.operatorWalletAddress ?? null}
            daoTreasuryAddress={node.daoAddress ?? null}
            nodeId={nodeId}
            repoSpecUrl={repoSpecUrl}
            daoUrl={daoUrl}
          />
        );
      }
    }
  }

  const operatorWallet = getOperatorWalletConfig();
  const daoTreasury = getDaoTreasuryAddress();

  return (
    <PaymentActivationPageClient
      operatorWalletAddress={operatorWallet?.address ?? null}
      daoTreasuryAddress={daoTreasury ?? null}
    />
  );
}
