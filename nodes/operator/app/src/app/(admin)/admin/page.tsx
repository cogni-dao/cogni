// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@app/(admin)/admin/page`
 * Purpose: Index landing for the `(admin)/` route group — entry to approver surfaces + treasury services.
 * Scope: Server component. Access gating handled upstream by `(admin)/layout.tsx`; reads session only to show the connected admin wallet.
 * Invariants: Links ONLY to surfaces that exist today (epoch review/sign + governance views + provider top-ups). Does not fabricate metrics.
 * Side-effects: IO (auth session read)
 * Links: src/app/(admin)/layout.tsx, src/app/(app)/gov/review/page.tsx, src/app/(admin)/admin/payments/page.tsx
 * @public
 */

import {
  Activity,
  ChevronRight,
  FileSignature,
  Layers,
  PieChart,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import type { ReactElement } from "react";

import { Badge, Card, CardContent } from "@/components";
import { getServerSessionUser } from "@/lib/auth/server";

const PRIMARY_ACTION = {
  href: "/gov/review",
  title: "Epoch Review & Sign",
  description:
    "Review pending epoch ledgers, adjust per-contribution weights, and sign to finalize. EIP-712 typed-data flow.",
  icon: FileSignature,
} as const;

const GOVERNANCE_VIEWS = [
  {
    href: "/gov/epoch",
    title: "Current Epoch",
    description: "Contributions accruing in the open epoch.",
    icon: Layers,
  },
  {
    href: "/gov/holdings",
    title: "Holdings",
    description: "Aggregated attribution shares across claimants.",
    icon: PieChart,
  },
  {
    href: "/gov/system",
    title: "Governance System",
    description: "Schedule, sync status, and on-chain signal execution.",
    icon: Activity,
  },
] as const;

const TREASURY_SERVICES = [
  {
    href: "/admin/payments",
    title: "Provider Top-Ups",
    description:
      "Fund the steward wallet from the operator wallet, then settle vendor invoices (OpenRouter, Cherry) in USDC.",
    icon: Wallet,
  },
] as const;

function shortWallet(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export default async function AdminIndexPage(): Promise<ReactElement> {
  const user = await getServerSessionUser();
  const wallet = user?.walletAddress ?? null;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-8 p-6">
      <header className="space-y-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary/15">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="font-bold text-3xl tracking-tight">DAO Admin</h1>
            <p className="text-muted-foreground text-sm">
              Approver-gated surfaces for epoch governance, attribution, and
              treasury services.
            </p>
          </div>
        </div>
        {wallet ? (
          <div className="flex items-center gap-2">
            <Badge intent="secondary" size="sm">
              Admin
            </Badge>
            <span className="font-mono text-muted-foreground text-xs">
              {shortWallet(wallet)}
            </span>
          </div>
        ) : null}
      </header>

      <Link href={PRIMARY_ACTION.href} className="group block">
        <Card className="overflow-hidden border-primary/30 transition hover:border-primary/60 hover:shadow-lg">
          <CardContent className="flex items-center gap-5 p-6">
            <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-primary/15">
              <PRIMARY_ACTION.icon className="h-7 w-7 text-primary" />
            </div>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <h2 className="font-semibold text-lg">
                  {PRIMARY_ACTION.title}
                </h2>
                <Badge intent="default" size="sm">
                  Primary
                </Badge>
              </div>
              <p className="text-muted-foreground text-sm">
                {PRIMARY_ACTION.description}
              </p>
            </div>
            <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
          </CardContent>
        </Card>
      </Link>

      <section className="space-y-3">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Treasury &amp; Services
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {TREASURY_SERVICES.map((item) => (
            <Link key={item.href} href={item.href} className="group block">
              <Card className="h-full transition hover:border-primary/50 hover:shadow-md">
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <item.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-semibold">{item.title}</h3>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {item.description}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium text-muted-foreground text-xs uppercase tracking-wider">
          Governance &amp; Attribution
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          {GOVERNANCE_VIEWS.map((item) => (
            <Link key={item.href} href={item.href} className="group block">
              <Card className="h-full transition hover:border-primary/50 hover:shadow-md">
                <CardContent className="flex items-start gap-4 p-5">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                    <item.icon className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="font-semibold">{item.title}</h3>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground transition group-hover:translate-x-1 group-hover:text-primary" />
                    </div>
                    <p className="text-muted-foreground text-sm">
                      {item.description}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
