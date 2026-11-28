// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/layout`
 * Purpose: Server-side gate + sidebar shell for DAO admin pages.
 * Scope: Server component. Checks the authenticated user against the same
 *   bound-wallet DAO authority as the AI access API. Denied users redirect;
 *   unavailable authority fails closed as an error.
 * Invariants: Page and API use the same user identity and admin decision.
 * Side-effects: IO (session and authority reads), structured gate log, redirect.
 * Links: src/bootstrap/agent-tool-authority.ts, .cogni/repo-spec.yaml
 * @public
 */

import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { getAdminAiAccessCalls } from "@/bootstrap/agent-tool-authority";
import { getServerSessionUser } from "@/lib/auth/server";
import { makeLogger } from "@/shared/observability";

import { AdminShell } from "./AdminShell";

const log = makeLogger({ route: "admin.gate" });

export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}): Promise<ReactNode> {
  const user = await getServerSessionUser();
  if (!user?.id) {
    log.warn({ userId: null, allowed: false }, "admin gate denied");
    redirect("/dashboard");
  }

  // Both the page and API resolve wallets from the authenticated user ID.
  // A GitHub session can have no wallet snapshot despite a live binding.
  const binding = await getAdminAiAccessCalls(user.id);
  if (!binding.ok && binding.status === 503) {
    throw new Error("admin authority unavailable");
  }
  if (!binding.ok) {
    log.warn({ userId: user?.id ?? null, allowed: false }, "admin gate denied");
    redirect("/dashboard");
  }

  log.info({ userId: user?.id ?? null, allowed: true }, "admin gate allowed");
  return <AdminShell>{children}</AdminShell>;
}
