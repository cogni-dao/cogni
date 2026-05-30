// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/setup/dao/layout`
 * Purpose: Setup section layout with sub-navigation tabs.
 * Scope: Wraps /setup/dao/* routes with tab navigation. Does not handle authentication or data fetching.
 * Invariants: Uses NavigationLink with match modes for correct active highlighting.
 * Side-effects: none
 * Links: docs/spec/node-formation.md
 * @public
 */

"use client";

import { CreditCard, Shield } from "lucide-react";
import { useSearchParams } from "next/navigation";
import type { ReactElement, ReactNode } from "react";

import { NavigationLink } from "@/components";

const SETUP_TABS = [
  {
    href: "/setup/dao",
    label: "Formation",
    icon: Shield,
    match: "exact" as const,
  },
  {
    href: "/setup/dao/payments",
    label: "Payments",
    icon: CreditCard,
    match: "prefix" as const,
  },
];

export default function SetupDaoLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  const searchParams = useSearchParams();
  const nodeId = searchParams?.get("nodeId");

  if (nodeId) {
    return <>{children}</>;
  }

  return (
    <div className="flex flex-col gap-6 p-5 md:p-6">
      <nav
        className="flex items-center gap-1 overflow-x-auto rounded-lg border bg-card p-1"
        aria-label="Setup sections"
      >
        {SETUP_TABS.map(({ href, label, icon: Icon, match }) => (
          <NavigationLink
            key={href}
            href={href}
            match={match}
            className="flex items-center gap-2 rounded-md px-3 py-2"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="whitespace-nowrap">{label}</span>
          </NavigationLink>
        ))}
      </nav>
      <div>{children}</div>
    </div>
  );
}
