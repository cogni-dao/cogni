// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/KeyFeatures`
 * Purpose: Displays the key features of the boilerplate (Next.js, Hexagonal, Crypto).
 * Scope: Homepage only. Does not handle data fetching.
 * Invariants: None.
 * Side-effects: none
 * Links: None.
 */

import { CreditCard, Database, Layers } from "lucide-react";
import type { ReactElement } from "react";

const FEATURES = [
  {
    icon: Layers,
    title: "Next.js and React",
    description:
      "Leverage the power of modern web technologies for optimal performance and developer experience.",
  },
  {
    icon: Database,
    title: "Hexagonal Architecture",
    description:
      "Clean domain boundaries with ports and adapters for swappable infrastructure and testable business logic.",
  },
  {
    icon: CreditCard,
    title: "Crypto-Only Payments",
    description:
      "All infrastructure and AI costs paid via DAO-controlled crypto wallets with full transparency.",
  },
];

export function KeyFeatures(): ReactElement {
  return (
    <section className="w-full bg-background py-12 md:py-24">
      <div className="mx-auto max-w-7xl px-4 sm:px-6">
        <div className="grid gap-12 md:grid-cols-3 md:gap-8">
          {FEATURES.map((feature) => (
            <div key={feature.title} className="flex flex-col items-start">
              <div className="mb-4 flex size-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
                <feature.icon className="size-6" />
              </div>
              <h3 className="mb-2 font-bold text-foreground text-xl">
                {feature.title}
              </h3>
              <p className="text-base text-muted-foreground">
                {feature.description}
              </p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
