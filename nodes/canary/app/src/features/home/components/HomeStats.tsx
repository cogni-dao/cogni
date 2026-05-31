// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/**
 * Module: `@features/home/components/HomeStats`
 * Purpose: Typographic stats row for homepage.
 * Scope: Renders a row of key metrics. Does not fetch data.
 * Invariants: Responsive grid/flex layout.
 * Side-effects: none
 * Notes: "Stats-first" feel - big value, small label.
 * Links: src/app/(public)/page.tsx
 * @public
 */

"use client";

import { cn } from "@cogni/node-ui-kit/util/cn";
import { motion } from "framer-motion";
import type { ReactElement } from "react";

interface StatItem {
  value: string;
  label: string;
}

const STATS: StatItem[] = [
  { value: "0%", label: "Payment Fees" },
  { value: "1", label: "Starter Kit" },
  { value: "2", label: "Critical Services" },
  { value: "12k+", label: "Community-Source Files" },
];

export function HomeStats(): ReactElement {
  return (
    <section className="w-full border-border border-t bg-background py-12 md:py-16">
      <div className="mx-auto grid max-w-7xl grid-cols-2 gap-8 px-4 sm:px-6 lg:grid-cols-4">
        {STATS.map((stat) => (
          <motion.div
            key={stat.label}
            className={cn(
              "relative flex flex-col items-center justify-center overflow-hidden rounded-2xl bg-transparent p-8"
            )}
            initial="initial"
            whileHover="hover"
            variants={{
              initial: {
                scale: 1,
                borderTopWidth: "0px",
                borderTopColor: "transparent",
                boxShadow: "none",
                backgroundColor: "transparent",
              },
              hover: {
                scale: 1.05,
                borderTopWidth: "2px",
                borderTopColor: "hsl(var(--primary))",
                boxShadow:
                  "0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05)", // shadow-lg equivalent
                backgroundColor: "rgba(var(--primary), 0.02)", // Very subtle tint
              },
            }}
            transition={{ duration: 0.2 }}
          >
            <span className="font-bold text-4xl text-foreground tracking-tight sm:text-5xl">
              {stat.value}
            </span>
            <span className="mt-2 font-medium text-muted-foreground text-sm uppercase tracking-wider">
              {stat.label}
            </span>
          </motion.div>
        ))}
      </div>
    </section>
  );
}
