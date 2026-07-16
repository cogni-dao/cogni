// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/dashboard/page`
 * Purpose: Live operations dashboard page shell. Resolves the live node network server-side (the same
 *   honest, cached, junk-filtered `NodeRegistryPort.listPublic()` the homepage/gallery use) and hands
 *   it to the client view for the Fleet/Infra card's NODES table — never a client per-node RBAC fan-out.
 * Scope: Auth check + a single server-side registry read. Does not implement business logic.
 * Invariants: Protected route (server-side auth check); the registry is read via the port at the
 *   container seam (cached server-side), never probed per-render.
 * Side-effects: IO (session check, registry read)
 * Links: [DashboardView](./view.tsx), src/bootstrap/container.ts (resolveNodeRegistry),
 *   src/ports/node-registry.port.ts
 * @public
 */

import { redirect } from "next/navigation";

import { resolveNodeRegistry } from "@/bootstrap/container";
import { getServerSessionUser } from "@/lib/auth/server";
import { DashboardView } from "./view";

export default async function DashboardPage() {
  const user = await getServerSessionUser();
  if (!user) {
    redirect("/");
  }

  const nodes = await resolveNodeRegistry().listPublic();

  return <DashboardView nodes={nodes} />;
}
