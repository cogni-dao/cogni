// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(app)/gov/layout`
 * Purpose: Governance section layout with sub-navigation tabs.
 * Scope: Wraps all /gov/* routes with tab navigation. Owns the outer container padding. Does not handle authentication or data fetching.
 * Invariants: Uses NavigationLink with match modes for correct active highlighting.
 * Side-effects: none
 * Links: src/components/kit/navigation/NavigationLink.tsx
 * @public
 */

"use client";

import {
  Activity,
  FileSignature,
  LayoutDashboard,
  PieChart,
} from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { NavigationLink } from "@/components";

const GOV_TABS = [
  {
    href: "/gov/holdings",
    label: "Ownership",
    icon: PieChart,
    match: "prefix" as const,
  },
  {
    href: "/gov/epoch",
    label: "Epochs",
    icon: Activity,
    match: "prefix" as const,
  },
  {
    href: "/gov/review",
    label: "Review",
    icon: FileSignature,
    match: "prefix" as const,
  },
  {
    href: "/gov/system",
    label: "System",
    icon: LayoutDashboard,
    match: "prefix" as const,
  },
];

export default function GovLayout({
  children,
}: {
  children: ReactNode;
}): ReactElement {
  return (
    <div className="flex flex-col gap-6 p-5 md:p-6">
      <nav
        className="flex items-center gap-1 overflow-x-auto rounded-lg border bg-card p-1"
        aria-label="Governance sections"
      >
        {GOV_TABS.map(({ href, label, icon: Icon, match }) => (
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
